import { useEffect, useState } from 'react';
import { Icon } from './icons';

/**
 * The narrow-screen gate.
 *
 * The shell is a three-column desktop layout; below phone width it crushes
 * into slivers of vertical text. Rather than ship that, a phone-sized
 * viewport gets pointed at the real apps — with a quiet escape hatch for the
 * person resizing a desktop window who knows what they are doing.
 */

const DISMISS_KEY = 'yappy.narrow.continue';

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function narrowDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function MobileGate(props: { onContinue: () => void }) {
  const android = /Android/i.test(navigator.userAgent);
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* fine — the gate returns next session */
    }
    props.onContinue();
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card mobile-gate">
        <h1 className="brand">
          yappy<span className="tongue">.</span>
        </h1>
        <div className="auth-sub">
          This screen is a little small for the web app — yappy is better in your pocket.
        </div>

        {(!ios || android) && (
          <a
            className="btn-accent gate-store"
            href="https://play.google.com/store/apps/details?id=gg.yappy.app"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="download" size={17} /> Get it on Google Play
          </a>
        )}
        {(!android || ios) && (
          <a className="btn-quiet gate-store" href="https://yappy.gg" target="_blank" rel="noreferrer">
            <Icon name="download" size={17} /> iPhone — yappy.gg
          </a>
        )}

        <div className="auth-switch">
          <button type="button" onClick={dismiss}>
            Continue in the browser anyway
          </button>
        </div>
      </div>
    </div>
  );
}
