import { useEffect, useState } from "react";
import {
  community,
  errorText,
  openMessage,
  when,
  type Collection,
  type Saved,
} from "./community";
import { SaveEditor, CommunityDialog } from "./CommunityDialogs";
import { ensureSaved, rememberSaved } from "../chat/saved";
import { api } from "../../lib/api";
import "./community.css";

export function SavedScreen() {
  const [items, setItems] = useState<Saved[]>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Saved>();
  const [rename, setRename] = useState<Collection>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void ensureSaved();
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () => {
        setError("");
        void Promise.all([
          community<{ items: Saved[] }>(
            `/saved?q=${encodeURIComponent(query)}${folder ? "&collectionId=" + folder : ""}`,
          ),
          community<{ collections: Collection[] }>("/collections"),
        ])
          .then(([s, c]) => {
            if (active) {
              setItems(s.items);
              setCollections(c.collections);
            }
          })
          .catch((e) => {
            if (active) setError(errorText(e));
          });
      },
      query ? 250 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, folder, version]);
  const current = collections.find((c) => c.id === folder);
  return (
    <main className="community community-screen">
      <header>
        <div>
          <h1>Saved</h1>
          <p>Your good finds, with a place for every thought.</p>
        </div>
      </header>
      <label>
        Search saved messages and notes
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find something you kept…"
        />
      </label>
      <nav className="community-tabs" aria-label="Saved collections">
        <button aria-pressed={!folder} onClick={() => setFolder("")}>
          All saved
        </button>
        {collections.map((c) => (
          <button
            key={c.id}
            aria-pressed={folder === c.id}
            onClick={() => setFolder(c.id)}
          >
            {c.name} · {c.count ?? 0}
          </button>
        ))}
      </nav>
      {current && (
        <div className="community-actions">
          <button onClick={() => setRename(current)}>Rename collection</button>
          <button
            disabled={busy}
            onClick={async () => {
              if (
                !window.confirm(
                  "Delete this collection? Your saved messages and notes will stay.",
                )
              )
                return;
              setBusy(true);
              try {
                await community(`/collections/${current.id}`, "DELETE");
                setFolder("");
                setVersion((v) => v + 1);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete collection
          </button>
        </div>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setVersion((v) => v + 1)}>Retry</button>
        </p>
      )}
      {!items && !error && <p>Loading saved messages…</p>}
      {items?.length === 0 && (
        <div className="community-empty">
          <h2>
            {query ? "No matching saved messages" : "Keep the good stuff here"}
          </h2>
          <p>
            Save a message, then add it to a collection and leave yourself a
            note.
          </p>
        </div>
      )}
      {items?.map((item) => (
        <article className="community-card" key={item.messageId}>
          <small>
            {item.sender} · {item.conversationTitle || "Direct message"} ·{" "}
            {when(item.savedAt)}
          </small>
          <blockquote>{item.content}</blockquote>
          {item.note && <p>Note: {item.note}</p>}
          <div className="community-actions">
            <button
              onClick={() => void openMessage(item.conversationId, item.seq)}
            >
              View message
            </button>
            <button onClick={() => setEditing(item)}>Collection & note</button>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(
                    `/conversations/${item.conversationId}/messages/${item.messageId}/save`,
                    { method: "DELETE" },
                  );
                  rememberSaved(item.messageId, false);
                  setVersion((v) => v + 1);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </button>
          </div>
        </article>
      ))}
      {editing && (
        <SaveEditor
          item={editing}
          onClose={() => setEditing(undefined)}
          onDone={() => setVersion((v) => v + 1)}
        />
      )}
      {rename && (
        <CommunityDialog
          title="Rename collection"
          onClose={() => setRename(undefined)}
          busy={busy}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await community(`/collections/${rename.id}`, "PATCH", {
                  name: rename.name,
                });
                setRename(undefined);
                setVersion((v) => v + 1);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Name
              <input
                required
                maxLength={40}
                value={rename.name}
                onChange={(e) =>
                  setRename((r) => (r ? { ...r, name: e.target.value } : r))
                }
              />
            </label>
            <button className="primary" disabled={busy}>
              Save name
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        </CommunityDialog>
      )}
    </main>
  );
}
