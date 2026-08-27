import { Icon } from '../icons';
import { MediaIcon } from './mediaIcons';
import type { UploadItem } from './useAttachmentUpload';
import './media.css';

/**
 * Pending attachments, rendered above the composer. Purely presentational —
 * the state and callbacks come from `useAttachmentUpload()`.
 */
export function AttachmentTray(props: {
  items: UploadItem[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (props.items.length === 0) return null;

  return (
    <div className="attach-tray" role="list" aria-label="Pending attachments">
      {props.items.map((item) => (
        <div
          key={item.id}
          role="listitem"
          className={`attach-tile${item.status === 'error' ? ' errored' : ''}`}
          title={item.file.name}
        >
          <TilePreview item={item} />

          {(item.status === 'uploading' || item.status === 'confirming') && (
            <div className="attach-progress" aria-label="Uploading">
              <ProgressRing progress={item.status === 'confirming' ? 1 : item.progress} />
            </div>
          )}

          {item.status === 'error' && (
            <div className="attach-error">
              <span className="attach-error-text">{item.error ?? 'Upload failed'}</span>
              <button
                className="attach-retry"
                onClick={() => props.onRetry(item.id)}
                aria-label={`Retry uploading ${item.file.name}`}
              >
                <MediaIcon name="retry" size={16} />
              </button>
            </div>
          )}

          <button
            className="attach-remove"
            onClick={() => props.onRemove(item.id)}
            aria-label={`Remove ${item.file.name}`}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function TilePreview({ item }: { item: UploadItem }) {
  if (item.previewUrl && item.file.type.startsWith('image/')) {
    return <img className="attach-thumb" src={item.previewUrl} alt={item.file.name} />;
  }
  if (item.previewUrl && item.file.type.startsWith('video/')) {
    return <video className="attach-thumb" src={item.previewUrl} muted playsInline preload="metadata" />;
  }
  return (
    <div className="attach-file">
      <MediaIcon name="file" size={22} />
      <span className="attach-file-name">{item.file.name}</span>
    </div>
  );
}

function ProgressRing({ progress }: { progress: number }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, progress));
  return (
    <svg width={36} height={36} viewBox="0 0 36 36" aria-hidden>
      <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        transform="rotate(-90 18 18)"
        style={{ transition: 'stroke-dashoffset 0.15s linear' }}
      />
    </svg>
  );
}
