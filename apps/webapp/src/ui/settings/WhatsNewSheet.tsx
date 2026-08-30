import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Icon, type IconName } from '../icons';
import { ExtraIcon, type ExtraIconName } from './extraIcons';

/**
 * The What's New sheet: GET /meta/changelog rendered the way the phones render
 * it — title, version · date, intro, then sections of bold-lead-in bullets.
 * Shapes mirror packages/shared/src/release.ts (the platform field never
 * reaches the wire; the server filters sections for us).
 */

interface ReleaseNoteItem {
  title: string;
  body: string;
  url?: string;
}

interface ReleaseNoteSection {
  heading: string;
  icon?: string;
  items: ReleaseNoteItem[];
}

interface ReleaseNote {
  id: string;
  version: string;
  date: string;
  title: string;
  intro?: string;
  sections: ReleaseNoteSection[];
}

/**
 * The server names section icons as SF Symbols (iOS drew these first). Like
 * Android's `releaseIcon` table, we map the small generic set the notes
 * actually use onto our own glyphs and draw nothing for the rest.
 */
function releaseIcon(name: string | undefined): JSX.Element | null {
  const base = name?.replace(/\.fill$/, '');
  const shared: Record<string, IconName> = {
    sparkles: 'sparkle',
    'wand.and.stars': 'sparkle',
    pawprint: 'paw',
    'hand.draw': 'edit',
    'person.badge.key': 'shield',
    'person.crop.circle.badge.checkmark': 'check',
    'checkmark.seal': 'check',
    bell: 'bell',
    'bell.badge': 'bell',
    speedometer: 'chart',
    gauge: 'chart',
    lock: 'shield',
    'lock.shield': 'shield',
    'bubble.left': 'chat',
    'bubble.left.and.bubble.right': 'chat',
    message: 'chat',
    'face.smiling': 'smile',
    photo: 'image',
  };
  const extra: Record<string, ExtraIconName> = {
    bolt: 'bolt',
    ladybug: 'bug',
    ant: 'bug',
    phone: 'phone',
    video: 'phone',
  };
  if (!base) return null;
  const sharedName = shared[base];
  if (sharedName) return <Icon name={sharedName} size={14} />;
  const extraName = extra[base];
  if (extraName) return <ExtraIcon name={extraName} size={14} />;
  return null;
}

function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function WhatsNewSheet(props: { onClose: () => void }) {
  const [notes, setNotes] = useState<ReleaseNote[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    api<{ notes: ReleaseNote[] }>('/meta/changelog?platform=web')
      .then((res) => {
        if (!cancelled) setNotes(res.notes);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="stg-overlay" onClick={props.onClose}>
      <div className="wn-sheet" role="dialog" aria-label="What's new" onClick={(e) => e.stopPropagation()}>
        <div className="wn-head">
          <div className="wn-head-title">What's New</div>
          <button className="wn-close" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="wn-scroll">
          {error && (
            <div className="wn-status">
              That did not load.
              <div>
                <button className="btn-accent" onClick={() => setAttempt((n) => n + 1)}>
                  Retry
                </button>
              </div>
            </div>
          )}
          {!error && notes === null && <div className="wn-status">Loading…</div>}
          {!error && notes !== null && notes.length === 0 && (
            <div className="wn-status">Nothing new to report. Suspiciously quiet.</div>
          )}
          {notes?.map((note) => (
            <article key={note.id} className="wn-note">
              <div className="wn-note-hero">
                <div className="wn-note-title">{note.title}</div>
              </div>
              <div className="wn-note-meta">
                {note.version} · {formatDate(note.date)}
              </div>
              {note.intro && <p className="wn-note-intro">{note.intro}</p>}
              {note.sections.map((section, i) => (
                <section key={i}>
                  <div className="wn-section-h">
                    {releaseIcon(section.icon)}
                    <span>{section.heading}</span>
                  </div>
                  {section.items.map((item, j) => (
                    <p key={j} className="wn-item">
                      <span className="wn-item-title">{item.title}. </span>
                      <span className="wn-item-body">
                        {item.body}
                        {item.url && (
                          <>
                            {' '}
                            <a href={item.url} target="_blank" rel="noreferrer">
                              {item.url.replace(/^https?:\/\//, '')}
                            </a>
                          </>
                        )}
                      </span>
                    </p>
                  ))}
                </section>
              ))}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
