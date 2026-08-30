/**
 * Voice notes: recording (MediaRecorder → audio/webm, mp4 fallback) and
 * playback (compact player with the server's waveform when present).
 *
 * Upload follows the same three-step media contract as attachments
 * (create → presigned PUT → confirm) but goes direct rather than through
 * `useAttachmentUpload`, because a voice note carries `purpose: 'voice'`,
 * a waveform and a duration, none of which the generic tray sends.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuthedMedia } from '../../lib/authedMedia';
import type { AttachmentWire } from './Blurhash';
import { MicIcon, PauseIcon, PlayIcon, StopIcon } from './icons-local';
import { Icon } from '../icons';

// ── Recording ────────────────────────────────────────────────────────────────

const MAX_SECONDS = 300;

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export interface VoiceRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  /** 0-100 amplitude buckets, ≤64 bars. */
  waveform: number[];
}

interface RecorderInternals {
  recorder: MediaRecorder;
  stream: MediaStream;
  audioCtx: AudioContext;
  chunks: Blob[];
  samples: number[];
  sampleTimer: number;
  startedAt: number;
  discard: boolean;
}

/** Merge raw amplitude samples down to ≤64 buckets scaled 0-100. */
function toWaveform(samples: number[]): number[] {
  if (samples.length === 0) return [];
  const bars = Math.min(64, samples.length);
  const per = samples.length / bars;
  const out: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    const slice = samples.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1));
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const peak = Math.max(...out, 0.001);
  return out.map((v) => Math.max(2, Math.min(100, Math.round((v / peak) * 100))));
}

export function useVoiceRecorder(onFinish: (rec: VoiceRecording) => void) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const internals = useRef<RecorderInternals | null>(null);
  const supported = pickMimeType() !== null && Boolean(navigator.mediaDevices?.getUserMedia);

  // Elapsed clock while recording.
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const it = internals.current;
      if (!it) return;
      const ms = Date.now() - it.startedAt;
      setElapsedMs(ms);
      if (ms >= MAX_SECONDS * 1000) stop();
    }, 200);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const teardown = () => {
    const it = internals.current;
    if (!it) return;
    window.clearInterval(it.sampleTimer);
    for (const track of it.stream.getTracks()) track.stop();
    void it.audioCtx.close().catch(() => {});
    internals.current = null;
    setRecording(false);
    setElapsedMs(0);
  };

  const start = async () => {
    const mimeType = pickMimeType();
    if (!mimeType || internals.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('microphone unavailable', err);
      return;
    }
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    const recorder = new MediaRecorder(stream, { mimeType });
    const it: RecorderInternals = {
      recorder,
      stream,
      audioCtx,
      chunks: [],
      samples: [],
      startedAt: Date.now(),
      discard: false,
      sampleTimer: window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        it.samples.push(Math.sqrt(sum / buf.length));
      }, 120),
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) it.chunks.push(e.data);
    };
    recorder.onstop = () => {
      const durationMs = Math.max(1, Date.now() - it.startedAt);
      const blob = new Blob(it.chunks, { type: mimeType.split(';')[0] });
      const waveform = toWaveform(it.samples);
      const wasDiscarded = it.discard;
      teardown();
      if (!wasDiscarded && blob.size > 0 && durationMs >= 400) {
        onFinish({ blob, mimeType: mimeType.split(';')[0]!, durationMs, waveform });
      }
    };
    internals.current = it;
    recorder.start(250);
    setRecording(true);
    setElapsedMs(0);
  };

  const stop = () => {
    const it = internals.current;
    if (it && it.recorder.state !== 'inactive') it.recorder.stop();
  };

  const cancel = () => {
    const it = internals.current;
    if (!it) return;
    it.discard = true;
    if (it.recorder.state !== 'inactive') it.recorder.stop();
    else teardown();
  };

  // Unmount mid-recording drops it.
  useEffect(() => cancel, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { supported, recording, elapsedMs, start, stop, cancel };
}

/** Create → PUT → confirm, with the voice-note extras. Returns the media id. */
export async function uploadVoiceRecording(rec: VoiceRecording): Promise<string> {
  const ext = rec.mimeType.includes('mp4') ? 'm4a' : 'webm';
  const created = await api<{
    media: { id: string };
    upload: { url: string; method: string; headers: Record<string, string> } | null;
  }>('/media/uploads', {
    method: 'POST',
    body: {
      filename: `voice-note.${ext}`,
      mimeType: rec.mimeType,
      size: rec.blob.size,
      purpose: 'voice',
      durationMs: Math.round(rec.durationMs),
      ...(rec.waveform.length > 0 ? { waveform: rec.waveform } : {}),
    },
  });
  if (!created.upload) return created.media.id; // deduplicated
  const headers = { ...created.upload.headers };
  delete headers['Content-Length'];
  delete headers['content-length'];
  const put = await fetch(created.upload.url, { method: 'PUT', headers, body: rec.blob });
  if (!put.ok) throw new Error(`Voice upload failed (${put.status})`);
  await api(`/media/${created.media.id}/confirm`, { method: 'POST' });
  return created.media.id;
}

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The composer's recording strip: pulsing dot, clock, cancel, stop-and-send. */
export function VoiceRecorderBar(props: {
  elapsedMs: number;
  busy: boolean;
  onCancel: () => void;
  onStop: () => void;
}) {
  return (
    <div className="voice-bar">
      <span className="voice-dot" aria-hidden />
      <MicIcon size={16} />
      <span className="voice-clock">{props.busy ? 'sending…' : fmtClock(props.elapsedMs)}</span>
      <button
        className="composer-btn"
        title="Discard recording"
        aria-label="Discard recording"
        onClick={props.onCancel}
        disabled={props.busy}
      >
        <Icon name="trash" size={18} />
      </button>
      <button
        className="send"
        title="Stop and send"
        aria-label="Stop and send"
        onClick={props.onStop}
        disabled={props.busy}
      >
        <StopIcon size={18} />
      </button>
    </div>
  );
}

// ── Playback ─────────────────────────────────────────────────────────────────

/** Compact player for any audio/* attachment; waveform bars when present. */
export function AudioAttachment(props: { attachment: AttachmentWire }) {
  const { attachment: a } = props;
  // Private-bucket audio sits behind Bearer auth an <audio> tag cannot send;
  // the hook fetches it with the token and hands back a blob URL.
  const src = useAuthedMedia(a.url);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [clock, setClock] = useState<number | null>(a.durationMs ?? null);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play().catch((err) => console.error('audio play failed', err));
  };

  const durationOf = (el: HTMLAudioElement): number | null =>
    Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : (a.durationMs ?? null);

  const waveform = Array.isArray(a.waveform) && a.waveform.length > 1 ? a.waveform : null;

  const seek = (fraction: number) => {
    const el = audioRef.current;
    const total = el ? durationOf(el) : null;
    if (!el || total === null) return;
    el.currentTime = (fraction * total) / 1000;
  };

  return (
    <div className="audio-note">
      <button
        className="audio-play"
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={toggle}
      >
        {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
      </button>

      {waveform ? (
        <div
          className="audio-wave"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - rect.left) / rect.width);
          }}
        >
          {waveform.map((v, i) => (
            <span
              key={i}
              className={`audio-bar${i / waveform.length <= progress ? ' played' : ''}`}
              style={{ height: `${Math.max(12, v)}%` }}
            />
          ))}
        </div>
      ) : (
        <div className="audio-track" onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - rect.left) / rect.width);
        }}>
          <div className="audio-track-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      <span className="audio-clock">{clock !== null ? fmtClock(clock) : '·:··'}</span>

      <audio
        ref={audioRef}
        src={src ?? undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          const el = audioRef.current;
          if (el) setClock(durationOf(el));
        }}
        onLoadedMetadata={(e) => setClock(durationOf(e.currentTarget))}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          const total = durationOf(el);
          if (total !== null && total > 0) {
            setProgress((el.currentTime * 1000) / total);
            setClock(playing ? el.currentTime * 1000 : total);
          }
        }}
      />
    </div>
  );
}
