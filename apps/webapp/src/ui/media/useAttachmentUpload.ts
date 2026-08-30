import { useCallback, useRef, useState } from 'react';
import { LIMITS } from '@yappy/shared';
import { api } from '../../lib/api';

/**
 * The attachment upload pipeline, client side.
 *
 * The server's contract (apps/api/src/routes/media.ts) is three steps:
 *
 *   1. POST /media/uploads {filename, mimeType, size, purpose, …}
 *      → { media, upload: { url, method: 'PUT', headers }, deduplicated: false }
 *      → or { media, upload: null, deduplicated: true } when the checksum
 *        matched bytes already in the bucket — steps 2 and 3 are skipped.
 *   2. PUT the raw file to `upload.url` with exactly `upload.headers`
 *      (a presigned S3 URL — no Authorization header, the signature IS the auth).
 *   3. POST /media/:id/confirm → { media } — marks it ready and queues
 *      thumbnails/transcodes. A media id is only safe to reference in a
 *      message after this succeeds.
 */

/** The server's media serialization (subset the client uses). */
export interface MediaDto {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  blurhash: string | null;
  filename: string | null;
  status: string;
}

export type UploadStatus = 'uploading' | 'confirming' | 'done' | 'error';

export interface UploadItem {
  /** Local id for list keys and remove/retry — NOT the server media id. */
  id: string;
  file: File;
  /** Object URL for image/video previews; revoke happens on remove/clear. */
  previewUrl: string | null;
  /** 0..1 across the PUT. */
  progress: number;
  status: UploadStatus;
  /** Set once confirmed (or deduplicated) — what goes into `attachmentIds`. */
  mediaId: string | null;
  media: MediaDto | null;
  error: string | null;
}

interface CreateUploadResponse {
  media: MediaDto;
  upload: { url: string; method: string; headers: Record<string, string>; expiresIn: number } | null;
  deduplicated: boolean;
}

/**
 * Mirror of the server's ALLOWED_MIME table (apps/api/src/lib/storage.ts) so a
 * doomed request never leaves the browser. Anything not listed uploads as
 * application/octet-stream, which the server accepts up to 200 MB.
 */
const MIME_MAX_BYTES: Record<string, number> = {
  'image/jpeg': 25_000_000,
  'image/png': 25_000_000,
  'image/webp': 25_000_000,
  'image/gif': 50_000_000,
  'image/heic': 40_000_000,
  'video/mp4': 500_000_000,
  'video/quicktime': 500_000_000,
  'video/webm': 500_000_000,
  'audio/mpeg': 50_000_000,
  'audio/mp4': 50_000_000,
  'audio/aac': 50_000_000,
  'audio/ogg': 50_000_000,
  'audio/opus': 25_000_000,
  'audio/webm': 25_000_000,
  'application/pdf': 100_000_000,
  'application/zip': 200_000_000,
  'text/plain': 10_000_000,
  'application/octet-stream': 200_000_000,
};

const FALLBACK_MIME = 'application/octet-stream';

export function validateFile(file: File): { ok: true; mimeType: string } | { ok: false; reason: string } {
  if (file.size <= 0) return { ok: false, reason: 'This file is empty' };
  const mimeType = MIME_MAX_BYTES[file.type] !== undefined ? file.type : FALLBACK_MIME;
  const cap = MIME_MAX_BYTES[mimeType] ?? 0;
  if (file.size > cap) {
    return { ok: false, reason: `Too large — the limit for this type is ${Math.floor(cap / 1_000_000)} MB` };
  }
  return { ok: true, mimeType };
}

/** SHA-256 hex for server-side dedupe. Skipped for big files and insecure contexts. */
async function sha256Hex(file: File): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle || file.size > 64_000_000) return null;
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Best-effort dimensions/duration so the server can render placeholders. */
function probeMedia(file: File): Promise<{ width?: number; height?: number; durationMs?: number }> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      resolve({});
      return;
    }
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (r: { width?: number; height?: number; durationMs?: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => finish({}), 4_000);

    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.onload = () => finish({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      img.onerror = () => finish({});
      img.src = url;
    } else {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () =>
        finish({
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
          durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) || undefined : undefined,
        });
      video.onerror = () => finish({});
      video.src = url;
    }
  });
}

/**
 * PUT the bytes to the presigned URL. XHR rather than fetch for upload
 * progress. `Content-Length` is a forbidden request header — the browser sets
 * it from the body, which matches because the presign signed the same size.
 */
function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (p: number) => void,
  onXhr: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr(xhr);
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'content-length') continue;
      try {
        xhr.setRequestHeader(name, value);
      } catch {
        /* forbidden header — the browser handles it */
      }
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
    xhr.send(file);
  });
}

export interface AttachmentUpload {
  items: UploadItem[];
  /** Validate and start uploading; silently caps at LIMITS.attachmentsPerMessage. */
  addFiles: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
  /** Drop everything (after a successful send, or on conversation switch). */
  clear: () => void;
  /** True while any PUT or confirm is still in flight. */
  isUploading: boolean;
  /** Every item errored or finished — i.e. nothing more will change on its own. */
  isSettled: boolean;
  /** Confirmed media ids, in tray order — the message's `attachmentIds`. */
  readyMediaIds: string[];
}

export function useAttachmentUpload(): AttachmentUpload {
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const filesRef = useRef(new Map<string, File>());
  const xhrsRef = useRef(new Map<string, XMLHttpRequest>());

  const commit = useCallback((fn: (prev: UploadItem[]) => UploadItem[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<UploadItem>) => {
      commit((prev) => prev.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    },
    [commit],
  );

  const run = useCallback(
    async (localId: string, file: File) => {
      patch(localId, { status: 'uploading', progress: 0, error: null });
      try {
        const verdict = validateFile(file);
        if (!verdict.ok) throw new Error(verdict.reason);

        const [probe, checksum] = await Promise.all([probeMedia(file), sha256Hex(file)]);

        const created = await api<CreateUploadResponse>('/media/uploads', {
          method: 'POST',
          body: {
            filename: file.name || 'file',
            mimeType: verdict.mimeType,
            size: file.size,
            purpose: 'attachment',
            ...(probe.width && probe.height ? { width: probe.width, height: probe.height } : {}),
            ...(probe.durationMs ? { durationMs: probe.durationMs } : {}),
            ...(checksum ? { checksum } : {}),
          },
        });

        if (created.upload) {
          await putWithProgress(
            created.upload.url,
            file,
            created.upload.headers,
            (p) => patch(localId, { progress: p }),
            (xhr) => xhrsRef.current.set(localId, xhr),
          );
          xhrsRef.current.delete(localId);
          patch(localId, { status: 'confirming', progress: 1 });
          const confirmed = await api<{ media: MediaDto }>(`/media/${created.media.id}/confirm`, {
            method: 'POST',
          });
          patch(localId, { status: 'done', mediaId: confirmed.media.id, media: confirmed.media });
        } else {
          // Deduplicated — the bytes already exist, the new row is ready as-is.
          patch(localId, { status: 'done', progress: 1, mediaId: created.media.id, media: created.media });
        }
      } catch (err) {
        xhrsRef.current.delete(localId);
        if ((err as { name?: string }).name === 'AbortError') return; // removed mid-flight
        patch(localId, {
          status: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        });
      }
    },
    [patch],
  );

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const room = Math.max(0, LIMITS.attachmentsPerMessage - itemsRef.current.length);
      const files = [...incoming].slice(0, room);
      if (files.length === 0) return;

      const next: UploadItem[] = files.map((file) => {
        const id = crypto.randomUUID();
        filesRef.current.set(id, file);
        const visual = file.type.startsWith('image/') || file.type.startsWith('video/');
        return {
          id,
          file,
          previewUrl: visual ? URL.createObjectURL(file) : null,
          progress: 0,
          status: 'uploading',
          mediaId: null,
          media: null,
          error: null,
        };
      });
      commit((prev) => [...prev, ...next]);
      for (const item of next) void run(item.id, item.file);
    },
    [commit, run],
  );

  const remove = useCallback(
    (id: string) => {
      xhrsRef.current.get(id)?.abort();
      xhrsRef.current.delete(id);
      filesRef.current.delete(id);
      const item = itemsRef.current.find((i) => i.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      commit((prev) => prev.filter((i) => i.id !== id));
    },
    [commit],
  );

  const retry = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id);
      if (file) void run(id, file);
    },
    [run],
  );

  const clear = useCallback(() => {
    for (const xhr of xhrsRef.current.values()) xhr.abort();
    xhrsRef.current.clear();
    filesRef.current.clear();
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    commit(() => []);
  }, [commit]);

  return {
    items,
    addFiles,
    remove,
    retry,
    clear,
    isUploading: items.some((i) => i.status === 'uploading' || i.status === 'confirming'),
    isSettled: items.every((i) => i.status === 'done' || i.status === 'error'),
    readyMediaIds: items.filter((i) => i.status === 'done' && i.mediaId).map((i) => i.mediaId as string),
  };
}
