import { useState } from 'react';
import { useAuthedMedia } from '../../lib/authedMedia';
import type { Attachment } from '../../lib/types';
import { Icon, type IconName } from '../icons';

/**
 * A file that is not a photo, a video, or a voice note.
 *
 * The server has taken PDFs, zips, text and arbitrary binaries since the
 * uploader was written; what was missing was the other half — anything that
 * was not media arrived as a paperclip and a filename with nothing to click.
 * A file you cannot open is not an attachment, it is a rumour.
 *
 * So: what it is, how big it is, and one obvious action. Size matters more here
 * than anywhere else in the app — the difference between a 40 KB contract and a
 * 180 MB archive decides whether somebody taps it on mobile data, and it is the
 * one thing a filename never tells you.
 */

/** Bytes as somebody would say them out loud. */
function humanSize(bytes: number | null | undefined): string | null {
  if (!bytes || bytes < 0) return null;
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal below ten, none above: "8.4 MB" is useful, "847.3 KB" is noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The shape of the thing, in one word.
 *
 * Deliberately coarse. A dozen icons for a dozen archive formats is a lot of
 * drawing to tell somebody what the file extension already told them; what the
 * icon is for is the glance that says "document" rather than "photo".
 */
function kindOf(
  mimeType: string,
  filename: string | null,
): { icon: IconName; label: string } {
  const ext = (filename?.split('.').pop() ?? '').toLowerCase();
  if (mimeType === 'application/pdf' || ext === 'pdf') return { icon: 'file', label: 'PDF' };
  if (mimeType === 'application/zip' || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return { icon: 'file', label: 'Archive' };
  }
  if (mimeType.startsWith('text/') || ['txt', 'md', 'csv', 'log'].includes(ext)) {
    return { icon: 'file', label: 'Text' };
  }
  if (mimeType.startsWith('image/')) return { icon: 'image', label: 'Image' };
  if (mimeType.startsWith('video/')) return { icon: 'image', label: 'Video' };
  if (mimeType.startsWith('audio/')) return { icon: 'volume', label: 'Audio' };
  return { icon: 'file', label: ext ? ext.toUpperCase() : 'File' };
}

export function FileAttachment(props: { attachment: Attachment }) {
  const { attachment } = props;
  const [busy, setBusy] = useState(false);
  const kind = kindOf(attachment.mimeType, attachment.filename);
  const size = humanSize(attachment.size);

  /**
   * Resolved on mount rather than on the click.
   *
   * Private-bucket media comes back as a blob through an authed fetch, and a
   * download triggered from inside an async click handler is exactly the thing
   * Safari treats as a popup and blocks. Having the href ready means the click
   * is a plain link click, which every browser allows.
   */
  const href = useAuthedMedia(attachment.url);
  const name = attachment.filename ?? 'file';

  return (
    <a
      className="msg-file"
      href={href ?? undefined}
      download={name}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={!href}
      onClick={(e) => {
        if (!href) {
          // Still fetching. Better to do nothing than to open a blank tab.
          e.preventDefault();
          setBusy(true);
        }
      }}
    >
      <span className="msg-file-icon">
        <Icon name={kind.icon} size={18} />
      </span>
      <span className="msg-file-text">
        <span className="msg-file-name">{name}</span>
        <span className="msg-file-meta">
          {[kind.label, size].filter(Boolean).join(' · ')}
          {busy && !href ? ' · preparing…' : ''}
        </span>
      </span>
      <span className="msg-file-action">
        <Icon name="download" size={16} />
      </span>
    </a>
  );
}
