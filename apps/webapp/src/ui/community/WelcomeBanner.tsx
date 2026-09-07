import { lazy, Suspense, useEffect, useState } from "react";
import { community, errorText, type WelcomePage } from "./community";
import "./community.css";
const GroupCommunity = lazy(() =>
  import("./CommunityScreen").then((m) => ({ default: m.GroupCommunity })),
);

export function WelcomeBanner({ conversationId }: { conversationId: string }) {
  const [page, setPage] = useState<WelcomePage>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setPage(undefined);
    void community<WelcomePage>(`/groups/${conversationId}/welcome`)
      .then((r) => {
        if (active) setPage(r);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [conversationId]);
  if (
    !page?.profile ||
    page.seen ||
    (!page.profile.welcome && !page.profile.rules)
  )
    return null;
  return (
    <div className="community community-welcome">
      <b>Welcome! Here’s a good place to start.</b>
      <div className="community-actions">
        <button onClick={() => setOpen(true)}>Read welcome & rules</button>
        <button
          onClick={() => {
            void community(`/groups/${conversationId}/welcome/read`, "POST")
              .then(() => setPage((p) => (p ? { ...p, seen: true } : p)))
              .catch((e) => setError(errorText(e)));
          }}
        >
          Got it
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {open && (
        <Suspense fallback={<p role="status">Loading welcome page…</p>}>
          <GroupCommunity
            conversationId={conversationId}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
