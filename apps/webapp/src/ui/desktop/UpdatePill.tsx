import { useEffect, useState } from 'react';
import { desktopRelaunch, onDesktopUpdateReady } from '../../lib/desktop';

/**
 * "yappy updated — restart" — shown when the shell has a fresh web bundle
 * staged. Dismissable, because the update also applies on whatever the next
 * natural restart is; the pill is an offer, not a demand.
 */
export function UpdatePill() {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    onDesktopUpdateReady(() => setReady(true));
  }, []);

  if (!ready || dismissed) return null;
  return (
    <div className="update-pill">
      <span>yappy updated</span>
      <button className="update-pill-go" onClick={desktopRelaunch}>
        Restart
      </button>
      <button className="update-pill-later" onClick={() => setDismissed(true)}>
        Later
      </button>
    </div>
  );
}
