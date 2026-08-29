import { useEffect, useState } from 'react';
import { acknowledgeSafety, checkSafety } from '../../lib/safety';
import type { SafetyState } from '../../lib/safety';
import { Icon } from '../icons';

/**
 * "Their safety number changed."
 *
 * Shown once, in the room it concerns, and worded so that the likely
 * explanation comes first: people reinstall and buy phones far more often than
 * they are intercepted. Leading with the alarming reading would train everybody
 * to dismiss it, which is exactly how a real one gets dismissed too.
 *
 * Dismissing records that this device has seen the new number. It does not
 * verify anything — that is a separate act, with a separate record on the
 * server, and the button says which one it is.
 */
export function SafetyBanner(props: { userId: string; name: string; onCompare: () => void }) {
  const [state, setState] = useState<SafetyState | null>(null);

  useEffect(() => {
    let live = true;
    void checkSafety(props.userId).then((result) => {
      if (live) setState(result?.changed ? result : null);
    });
    return () => {
      live = false;
    };
  }, [props.userId]);

  if (!state) return null;

  return (
    <div className="safety-bar" role="status">
      <Icon name="lock" size={14} />
      <span className="safety-bar-text">
        {state.wasVerified
          ? `${props.name}'s safety number changed since you compared it.`
          : `${props.name}'s safety number changed.`}{' '}
        <span className="safety-bar-why">Usually a new phone, or a reinstall.</span>
      </span>
      <button className="safety-bar-act" onClick={props.onCompare}>
        Compare
      </button>
      <button
        className="safety-bar-dismiss"
        onClick={() => {
          acknowledgeSafety(state.userId, state.safetyNumber);
          setState(null);
        }}
        aria-label="Dismiss"
        title="Dismiss"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
