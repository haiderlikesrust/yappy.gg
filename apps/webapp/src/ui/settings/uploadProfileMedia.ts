import { api } from '../../lib/api';

/**
 * Upload an avatar or banner through the media pipeline.
 *
 * Same three-step contract as attachments (see ui/media/useAttachmentUpload.ts
 * and apps/api/src/routes/media.ts), but with `purpose: 'avatar' | 'banner'` so
 * the object lands in the public bucket profile art is served from. The
 * attachment hook is deliberately not reused: it is a tray of many files wired
 * to `purpose: 'attachment'`, and this is one file with one progress number.
 *
 *   1. POST /media/uploads  → row + presigned PUT (or a dedupe hit, done)
 *   2. PUT the bytes        → straight to storage, progress via XHR
 *   3. POST /media/:id/confirm → ready; the id is then safe to PATCH onto /users/me
 */

interface MediaDto {
  id: string;
  url: string;
  status: string;
}

interface CreateUploadResponse {
  media: MediaDto;
  upload: { url: string; method: string; headers: Record<string, string>; expiresIn: number } | null;
  deduplicated: boolean;
}

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 25_000_000;

async function sha256Hex(file: File): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function probeImage(file: File): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const finish = (r: { width?: number; height?: number }) => {
      URL.revokeObjectURL(url);
      resolve(r);
    };
    img.onload = () => finish({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
    img.onerror = () => finish({});
    img.src = url;
  });
}

function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (p: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
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
    xhr.send(file);
  });
}

/** Returns the confirmed media id, ready for PATCH /users/me. */
export async function uploadProfileMedia(
  file: File,
  purpose: 'avatar' | 'banner',
  onProgress: (p: number) => void,
): Promise<string> {
  if (!ACCEPTED.has(file.type)) {
    throw new Error('Use a JPEG, PNG, WebP or GIF image');
  }
  if (file.size <= 0) throw new Error('This file is empty');
  if (file.size > MAX_BYTES) {
    throw new Error(`Too large — the limit is ${Math.floor(MAX_BYTES / 1_000_000)} MB`);
  }

  const [probe, checksum] = await Promise.all([probeImage(file), sha256Hex(file)]);

  const created = await api<CreateUploadResponse>('/media/uploads', {
    method: 'POST',
    body: {
      filename: file.name || purpose,
      mimeType: file.type,
      size: file.size,
      purpose,
      ...(probe.width && probe.height ? { width: probe.width, height: probe.height } : {}),
      ...(checksum ? { checksum } : {}),
    },
  });

  if (!created.upload) {
    // Deduplicated — the bytes already exist in the public bucket.
    onProgress(1);
    return created.media.id;
  }

  await putWithProgress(created.upload.url, file, created.upload.headers, onProgress);
  const confirmed = await api<{ media: MediaDto }>(`/media/${created.media.id}/confirm`, {
    method: 'POST',
  });
  return confirmed.media.id;
}
