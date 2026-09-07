import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "../icons";
import { rememberSaved } from "../chat/saved";
import {
  community,
  errorText,
  localInput,
  type Collection,
  type Saved,
} from "./community";
import "./community.css";

export function CommunityDialog({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const focus = useDialogFocus();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const dialogs = document.querySelectorAll(
          '[role="dialog"][aria-modal="true"]',
        );
        if (dialogs.item(dialogs.length - 1) !== focus.current) return;
        e.stopImmediatePropagation();
        if (!busy) onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose, busy, focus]);
  return createPortal(
    <div
      className="community-scrim"
      onMouseDown={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="community-dialog community"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={focus}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="close" size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function WhenDialog({
  messageId,
  conversationId,
  content,
  onClose,
  onDone,
}: {
  messageId?: string;
  conversationId?: string;
  content?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [time, setTime] = useState(localInput(new Date(Date.now() + 3600_000)));
  const [id] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <CommunityDialog
      title={messageId ? "Remind me" : "Schedule message"}
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await community(
              messageId ? "/reminders" : "/scheduled",
              "POST",
              messageId
                ? { id, messageId, dueAt: new Date(time).toISOString() }
                : {
                    id,
                    conversationId,
                    content,
                    sendAt: new Date(time).toISOString(),
                  },
            );
            onDone?.();
            onClose();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {messageId
            ? "Get a notification with a link back to this message."
            : "This text will be sent even when your devices are offline."}
        </p>
        {content && <blockquote>{content}</blockquote>}
        <div className="community-actions">
          {[
            ["In an hour", 1],
            ["Tomorrow", 24],
          ].map(([label, hours]) => (
            <button
              type="button"
              key={label}
              onClick={() =>
                setTime(
                  localInput(new Date(Date.now() + Number(hours) * 3600_000)),
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
        <label>
          When
          <input
            required
            type="datetime-local"
            value={time}
            min={localInput(new Date(Date.now() + 60_000))}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <small>
          Times are shown in your time zone. Manage these in Catch up.
        </small>
        {error && <p role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : messageId ? "Set reminder" : "Schedule message"}
        </button>
      </form>
    </CommunityDialog>
  );
}

export function SaveEditor({
  item,
  onClose,
  onDone,
}: {
  item: Pick<Saved, "messageId" | "collectionId" | "note">;
  onClose: () => void;
  onDone: () => void;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollection] = useState(item.collectionId ?? "");
  const [note, setNote] = useState(item.note);
  const [name, setName] = useState("");
  const [newId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void community<{ collections: Collection[] }>("/collections")
      .then((r) => {
        if (active) setCollections(r.collections);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <CommunityDialog title="Save to a collection" onClose={onClose} busy={busy}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            let target = collectionId || null;
            if (collectionId === "new") {
              await community("/collections", "POST", { id: newId, name });
              target = newId;
            }
            await community(`/saved/${item.messageId}`, "PUT", {
              collectionId: target,
              note,
            });
            rememberSaved(item.messageId, true);
            onDone();
            onClose();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Collection
          <select
            value={collectionId}
            onChange={(e) => setCollection(e.target.value)}
          >
            <option value="">All saved</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="new">New collection…</option>
          </select>
        </label>
        {collectionId === "new" && (
          <label>
            Collection name
            <input
              required
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <label>
          Personal note
          <textarea
            maxLength={2000}
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why you saved this…"
          />
        </label>
        <small>Collections and notes are visible only to you.</small>
        {error && <p role="alert">{error}</p>}
        <button
          className="primary"
          disabled={busy || (collectionId === "new" && !name.trim())}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </CommunityDialog>
  );
}
