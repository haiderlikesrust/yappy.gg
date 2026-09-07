import { useCallback, useEffect, useState } from "react";
import { mutate, syncUrl } from "../../state/store";
import {
  community,
  errorText,
  openMessage,
  when,
  localInput,
  type CatchUp,
  type CommunityEvent,
  type Reminder,
  type Scheduled,
  type WelcomePage,
  type Welcome,
} from "./community";
import { CommunityDialog } from "./CommunityDialogs";
import "./community.css";

export function CommunityScreen() {
  const [tab, setTab] = useState("Catch up");
  const [version, setVersion] = useState(0);
  const [catchUp, setCatchUp] = useState<CatchUp>();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const load = async () => {
      try {
        if (tab === "Catch up") {
          const r = await community<CatchUp>("/catch-up");
          if (active) setCatchUp(r);
        } else if (tab === "Reminders") {
          const r = await community<{ reminders: Reminder[] }>("/reminders");
          if (active) setReminders(r.reminders);
        } else if (tab === "Scheduled") {
          const r = await community<{ messages: Scheduled[] }>("/scheduled");
          if (active) setScheduled(r.messages);
        }
      } catch (err) {
        if (active) setError(errorText(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [tab, version]);
  const cancel = async (path: string, id: string) => {
    setBusy(id);
    try {
      await community(path + "/" + id, "DELETE");
      setVersion((v) => v + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  };
  return (
    <main className="community community-screen">
      <header>
        <div>
          <h1>Catch up</h1>
          <p>A little less scrolling. A little more together.</p>
        </div>
        <button
          onClick={() => setVersion((v) => v + 1)}
          aria-label="Refresh Catch up"
        >
          Refresh
        </button>
      </header>
      <nav className="community-tabs" aria-label="Catch up sections">
        {["Catch up", "Events", "Reminders", "Scheduled"].map((t) => (
          <button key={t} aria-pressed={t === tab} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <button
          onClick={() => {
            mutate((s) => {
              s.view = "saved";
            }, "ui");
            syncUrl();
          }}
        >
          Saved
        </button>
      </nav>
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setVersion((v) => v + 1)}>Try again</button>
        </p>
      )}
      {loading && tab !== "Events" ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          {tab === "Catch up" && catchUp && (
            <div className="community-grid">
              <section>
                <h2>Waiting for you</h2>
                {catchUp.items.length === 0 && (
                  <Empty
                    title="You’re caught up"
                    text="New mentions, replies, pins, and group updates will appear here."
                  />
                )}
                {catchUp.items.map((item) => (
                  <article className="community-card" key={item.id}>
                    <small>
                      {item.kind} · {item.conversationTitle || "Direct message"}
                    </small>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                    <button
                      className="link"
                      onClick={() =>
                        void openMessage(item.conversationId, item.seq)
                      }
                    >
                      View in conversation →
                    </button>
                  </article>
                ))}
              </section>
              <section>
                <h2>Unread conversations</h2>
                {catchUp.rooms.length === 0 && (
                  <Empty
                    title="All quiet here"
                    text="Your unread conversations will be easy to find here."
                  />
                )}
                {catchUp.rooms.map((room) => (
                  <article className="community-card" key={room.conversationId}>
                    <h3>{room.title}</h3>
                    <p>{room.unreadCount} unread</p>
                    <button
                      className="link"
                      onClick={() => void openMessage(room.conversationId)}
                    >
                      Catch up →
                    </button>
                  </article>
                ))}
              </section>
            </div>
          )}
          {tab === "Events" && <EventsPanel key={version} />}
          {tab === "Reminders" && (
            <>
              <p>
                Times use your device’s time zone. Reminders arrive in
                Notifications.
              </p>
              {!reminders.length && (
                <Empty
                  title="Nothing on your list"
                  text="Open a message’s actions and choose Remind me."
                />
              )}
              {reminders.map((r) => (
                <article className="community-card" key={r.id}>
                  <time>{when(r.dueAt)}</time>
                  <h3>{r.title}</h3>
                  <p>{r.conversationTitle || "Conversation"}</p>
                  <div className="community-actions">
                    <button
                      onClick={() => void openMessage(r.conversationId, r.seq)}
                    >
                      Open conversation
                    </button>
                    <button
                      disabled={busy === r.id}
                      onClick={() => void cancel("/reminders", r.id)}
                    >
                      Cancel reminder
                    </button>
                  </div>
                </article>
              ))}
            </>
          )}
          {tab === "Scheduled" && (
            <>
              <p>
                Messages send while you’re offline. Use the clock beside Send to
                schedule text.
              </p>
              {!scheduled.length && (
                <Empty
                  title="No scheduled messages"
                  text="A birthday wish or a note for tomorrow can wait here until it’s time."
                />
              )}
              {scheduled.map((s) => (
                <article className="community-card" key={s.id}>
                  <time>{when(s.sendAt)}</time>
                  <h3>{s.conversationTitle || "Conversation"}</h3>
                  <blockquote>{s.content}</blockquote>
                  {s.failedAt && <p role="alert">Not sent: {s.failure}</p>}
                  <button
                    disabled={busy === s.id}
                    onClick={() => void cancel("/scheduled", s.id)}
                  >
                    {s.failedAt ? "Dismiss" : "Cancel scheduled message"}
                  </button>
                </article>
              ))}
            </>
          )}
        </>
      )}
    </main>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="community-empty">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export function EventsPanel({
  conversationId,
  canManage = false,
}: {
  conversationId?: string;
  canManage?: boolean;
}) {
  const [events, setEvents] = useState<CommunityEvent[]>();
  const [editing, setEditing] = useState<CommunityEvent | "new" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void community<{ events: CommunityEvent[] }>(
      "/events" + (conversationId ? "?conversationId=" + conversationId : ""),
    )
      .then((r) => {
        if (active) setEvents(r.events);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [conversationId, version]);
  const action = async (
    id: string,
    method: string,
    path = "",
    body?: unknown,
  ) => {
    setBusy(id);
    try {
      await community(`/events/${id}${path}`, method, body);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <section>
      <header>
        <div>
          <h2>Make time for your people</h2>
          <p>Upcoming plans, shown in your local time.</p>
        </div>
        {conversationId && canManage && (
          <button onClick={() => setEditing("new")}>Create event</button>
        )}
      </header>
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setVersion((v) => v + 1)}>Retry</button>
        </p>
      )}
      {!events && !error && <p>Loading events…</p>}
      {events?.length === 0 && (
        <Empty
          title="The calendar’s open"
          text="Group admins can create an event from their group’s Events & welcome page."
        />
      )}
      {events?.map((event) => (
        <article className="community-card" key={event.id}>
          <small>{event.conversationTitle}</small>
          <h3>{event.title}</h3>
          <p>
            <time>{when(event.startsAt)}</time>
            {event.endsAt && <> – {when(event.endsAt)}</>}
          </p>
          {event.cancelledAt ? (
            <p>Cancelled</p>
          ) : (
            <>
              <p>{event.description}</p>
              {event.location && <p>{event.location}</p>}
              <small>
                {event.going} going · {event.maybe} maybe
              </small>
              {Date.parse(event.startsAt) > Date.now() && (
                <>
                  <div className="community-actions">
                    {[
                      ["going", "Going"],
                      ["maybe", "Maybe"],
                      ["declined", "Can’t go"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        aria-pressed={event.response === value}
                        disabled={busy === event.id}
                        onClick={() =>
                          void action(event.id, "PUT", "/rsvp", {
                            response: value,
                            remind: event.remind,
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={event.remind}
                      disabled={
                        busy === event.id ||
                        !event.response ||
                        event.response === "declined"
                      }
                      onChange={(e) =>
                        void action(event.id, "PUT", "/rsvp", {
                          response: event.response,
                          remind: e.target.checked,
                        })
                      }
                    />
                    Remind me 15 minutes before
                  </label>
                  {(canManage || event.canManage) && (
                    <div className="community-actions">
                      <button onClick={() => setEditing(event)}>
                        Edit event
                      </button>
                      <button
                        disabled={busy === event.id}
                        onClick={() => {
                          if (window.confirm("Cancel this event for everyone?"))
                            void action(event.id, "DELETE");
                        }}
                      >
                        Cancel event
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <button
            className="link"
            onClick={() => void openMessage(event.conversationId)}
          >
            Open group →
          </button>
        </article>
      ))}
      {editing && (
        <EventEditor
          conversationId={
            conversationId ?? (editing === "new" ? "" : editing.conversationId)
          }
          event={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onDone={() => setVersion((v) => v + 1)}
        />
      )}
    </section>
  );
}

function EventEditor({
  conversationId,
  event,
  onClose,
  onDone,
}: {
  conversationId: string;
  event?: CommunityEvent;
  onClose: () => void;
  onDone: () => void;
}) {
  const [id] = useState(() => event?.id ?? crypto.randomUUID());
  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [starts, setStarts] = useState(
    localInput(
      event ? new Date(event.startsAt) : new Date(Date.now() + 86400_000),
    ),
  );
  const [ends, setEnds] = useState(
    event?.endsAt ? localInput(new Date(event.endsAt)) : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <CommunityDialog
      title={event ? "Edit event" : "Create event"}
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const body = {
              title,
              description,
              location,
              startsAt: new Date(starts).toISOString(),
              endsAt: ends ? new Date(ends).toISOString() : null,
            };
            await community(
              event ? `/events/${id}` : `/groups/${conversationId}/events`,
              event ? "PATCH" : "POST",
              event ? body : { id, ...body },
            );
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
          Event name
          <input
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Game night"
          />
        </label>
        <label>
          About
          <textarea
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          Where
          <input
            maxLength={200}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="A channel, venue, or meeting link"
          />
        </label>
        <label>
          Starts
          <input
            type="datetime-local"
            required
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
          />
        </label>
        <label>
          Ends · optional
          <input
            type="datetime-local"
            value={ends}
            min={starts}
            onChange={(e) => setEnds(e.target.value)}
          />
        </label>
        <small>Everyone sees the time in their own time zone.</small>
        {error && <p role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save event"}
        </button>
      </form>
    </CommunityDialog>
  );
}

export function GroupCommunity({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<WelcomePage>();
  const [profile, setProfile] = useState<Welcome>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = useCallback(() => {
    void community<WelcomePage>(`/groups/${conversationId}/welcome`)
      .then((r) => {
        setPage(r);
        setProfile(r.profile);
      })
      .catch((e) => setError(errorText(e)));
  }, [conversationId]);
  useEffect(load, [load]);
  return (
    <CommunityDialog title="Events & welcome" onClose={onClose} busy={busy}>
      {error && (
        <p role="alert">
          {error} <button onClick={load}>Retry</button>
        </p>
      )}
      {!page ? (
        <p>Loading…</p>
      ) : (
        <>
          <EventsPanel
            conversationId={conversationId}
            canManage={page.canManage}
          />
          <h2>Welcome to the group</h2>
          {page.canManage ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setSaved(false);
                try {
                  await community(`/groups/${conversationId}/welcome`, "PUT", {
                    tags: (profile.tags ?? [])
                      .map((t) => t.trim())
                      .filter(Boolean),
                    language: profile.language ?? "",
                    welcome: profile.welcome ?? "",
                    rules: profile.rules ?? "",
                    startChannelId: profile.startChannelId ?? null,
                  });
                  setSaved(true);
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Welcome message
                <textarea
                  maxLength={2000}
                  value={profile.welcome ?? ""}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, welcome: e.target.value }))
                  }
                  placeholder="Help new members feel at home."
                />
              </label>
              <label>
                Group rules
                <textarea
                  maxLength={3000}
                  value={profile.rules ?? ""}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, rules: e.target.value }))
                  }
                />
              </label>
              <label>
                Starting channel
                <select
                  value={profile.startChannelId ?? ""}
                  onChange={(e) =>
                    setProfile((p) => ({
                      ...p,
                      startChannelId: e.target.value || null,
                    }))
                  }
                >
                  <option value="">No starting channel</option>
                  {(page.channels ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Interests · up to 5
                <input
                  value={(profile.tags ?? []).join(",")}
                  onChange={(e) =>
                    setProfile((p) => ({
                      ...p,
                      tags: e.target.value.split(","),
                    }))
                  }
                  placeholder="gaming,music,design"
                />
              </label>
              <label>
                Language
                <select
                  value={profile.language ?? ""}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, language: e.target.value }))
                  }
                >
                  {[
                    ["", "Any language"],
                    ["en", "English"],
                    ["ar", "Arabic"],
                    ["ur", "Urdu"],
                    ["hi", "Hindi"],
                    ["es", "Spanish"],
                    ["fr", "French"],
                    ["de", "German"],
                    ["pt", "Portuguese"],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={busy}>
                Save welcome page
              </button>
              {saved && <p role="status">Welcome page saved.</p>}
            </form>
          ) : (
            <>
              <p style={{ whiteSpace: "pre-wrap" }}>
                {profile.welcome || "Make yourself at home."}
              </p>
              {profile.rules && (
                <>
                  <h3>Group rules</h3>
                  <p style={{ whiteSpace: "pre-wrap" }}>{profile.rules}</p>
                </>
              )}
              {profile.startChannelId && (
                <button
                  onClick={() => {
                    void openMessage(profile.startChannelId!);
                    onClose();
                  }}
                >
                  Start here →
                </button>
              )}
            </>
          )}
        </>
      )}
    </CommunityDialog>
  );
}
