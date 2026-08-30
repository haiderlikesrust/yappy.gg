import { useRef, useState } from 'react';
import { useAuthedMedia } from '../../lib/authedMedia';
import type { Attachment } from '../../lib/types';

/**
 * A recorded round video note, told apart from a video *file* by the filename
 * its recorder stamps — the same marker every yappy client uses
 * (Android: VideoNote.kt `isVideoNote`).
 */
export const isVideoNoteAttachment = (a: Attachment): boolean =>
  a.mimeType.startsWith('video/') && (a.filename?.startsWith('video-note') ?? false);

/**
 * The circle. Click plays it in place with sound — a face in a circle is a
 * message, not footage, so it never opens the lightbox the way a video file
 * does.
 */
export function VideoNoteCircle(props: { attachment: Attachment }) {
  const src = useAuthedMedia(props.attachment.url);
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = (): void => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      el.muted = false;
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  return (
    <button
      className={`video-note${playing ? ' playing' : ''}`}
      onClick={toggle}
      title={playing ? 'Pause' : 'Play video note'}
      aria-label={playing ? 'Pause video note' : 'Play video note'}
    >
      {src && (
        <video
          ref={ref}
          src={src}
          playsInline
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            if (ref.current) ref.current.currentTime = 0;
          }}
        />
      )}
      {!playing && (
        <span className="video-note-play" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.5 5.8v12.4c0 .9 1 1.5 1.8 1L20 13c.7-.5.7-1.5 0-2L10.3 4.8c-.8-.5-1.8.1-1.8 1Z" />
          </svg>
        </span>
      )}
    </button>
  );
}
