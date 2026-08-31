import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons';
import { markTourDone } from './tourState';
import './tour.css';

/**
 * The first-run tour: a spotlight over the real interface, six stops, done.
 *
 * No library — a step names a selector, the overlay cuts a hole over the live
 * element with a box-shadow scrim and parks its card beside it. Steps whose
 * anchor is not on screen (no conversation open yet, say) skip themselves.
 * Shown once per browser; Settings can replay it.
 */


interface Step {
  /** null = centered welcome card, no spotlight. */
  selector: string | null;
  title: string;
  body: string;
  /** Which side of the anchor the card prefers. */
  side?: 'right' | 'left' | 'top' | 'bottom';
}

const STEPS: Step[] = [
  {
    selector: null,
    title: 'yappy, at your desk',
    body: 'Same groups, same pet, same chaos as your phone — with a keyboard. Thirty seconds of pointing, then it stays out of your way.',
  },
  {
    selector: '.sidebar-new',
    title: 'Start something',
    body: 'A DM, a group, or a campfire that burns out on its own. Your groups live below as cards — the pixel pet on a card is that group’s pet.',
    side: 'bottom',
  },
  {
    selector: '.rail-item:nth-of-type(2)',
    title: 'Explore',
    body: 'Public places worth wandering into — verified ones, rooms that are buzzing right now, and brand-new spots.',
    side: 'right',
  },
  {
    selector: null,
    title: 'Move at typing speed',
    body: 'Ctrl+K (⌘K on a Mac) jumps to any chat, finds people, and full-text searches every message you can see. Enter lands you on the result.',
  },
  {
    selector: '.composer',
    title: 'Say it any way',
    body: 'Files and photos, GIFs, stickers, polls, voice notes — and @ mentions or / commands as you type. Drag a file anywhere on the chat to send it.',
    side: 'top',
  },
  {
    selector: '.rail-item:nth-of-type(4)',
    title: 'Make it yours',
    body: 'Profile, flair, desktop notifications — and Developer mode, if you build bots. That’s the tour. Go yap.',
    side: 'right',
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function Tour(props: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [tick, setTick] = useState(0);

  // Resolve the current step to a live rect; skip steps with no anchor on
  // screen. `tick` re-measures on resize.
  const step = STEPS[index];
  useEffect(() => {
    if (!step) return;
    if (!step.selector) {
      setAnchor(null);
      return;
    }
    const el = document.querySelector(step.selector);
    if (!el) {
      // Anchor missing (e.g. no open conversation) — skip forward, or finish.
      setIndex((i) => (i + 1 < STEPS.length ? i + 1 : i));
      if (index + 1 >= STEPS.length) {
        markTourDone();
        props.onClose();
      }
      return;
    }
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.top, left: r.left, width: r.width, height: r.height });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, tick]);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const finish = useCallback(() => {
    markTourDone();
    props.onClose();
  }, [props]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'Enter' || e.key === 'ArrowRight') {
        setIndex((i) => {
          if (i + 1 >= STEPS.length) {
            finish();
            return i;
          }
          return i + 1;
        });
      }
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [finish]);

  const cardStyle = useMemo(() => {
    if (!anchor || !step?.selector) return undefined;
    const pad = 14;
    const width = 320;
    const side = step.side ?? 'right';
    let top = anchor.top;
    let left = anchor.left;
    if (side === 'right') {
      left = anchor.left + anchor.width + pad;
      top = anchor.top - 8;
    } else if (side === 'left') {
      left = anchor.left - width - pad;
      top = anchor.top - 8;
    } else if (side === 'bottom') {
      top = anchor.top + anchor.height + pad;
      left = anchor.left + anchor.width / 2 - width / 2;
    } else {
      top = anchor.top - pad - 180;
      left = anchor.left + anchor.width / 2 - width / 2;
    }
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    top = Math.max(12, Math.min(top, window.innerHeight - 220));
    return { top, left, width };
  }, [anchor, step]);

  if (!step) return null;
  const last = index === STEPS.length - 1;

  return (
    <div className="tour-root">
      {step.selector && anchor ? (
        <div
          className="tour-spot"
          style={{
            top: anchor.top - 6,
            left: anchor.left - 6,
            width: anchor.width + 12,
            height: anchor.height + 12,
          }}
        />
      ) : (
        <div className="tour-scrim" />
      )}

      <div className={`tour-card${step.selector ? '' : ' centered'}`} style={cardStyle}>
        <div className="tour-title brand">{step.title}</div>
        <div className="tour-body">{step.body}</div>
        <div className="tour-foot">
          <div className="tour-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`tour-dot${i === index ? ' on' : ''}`} />
            ))}
          </div>
          <div className="tour-actions">
            {!last && (
              <button className="tour-skip" onClick={finish}>
                Skip
              </button>
            )}
            {index > 0 && (
              <button className="tour-btn" onClick={() => setIndex((i) => i - 1)} aria-label="Back">
                <Icon name="chevron-left" size={15} />
              </button>
            )}
            <button
              className="tour-btn accent"
              onClick={() => (last ? finish() : setIndex((i) => i + 1))}
            >
              {last ? "Let's yap" : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
