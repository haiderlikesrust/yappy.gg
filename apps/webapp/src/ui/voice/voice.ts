/**
 * Voice channels — the client half.
 *
 * One LiveKit room at most, module-level: joining a second channel leaves the
 * first, exactly like Discord. The server owns who is inside (voice.state
 * snapshots on the space topic feed the sidebar); this module owns the local
 * session — the socket to the SFU, the mic, and the hidden <audio> elements
 * every remote track attaches to.
 */

import type { Room } from 'livekit-client';
import { api } from '../../lib/api';
import { getState, mutate } from '../../state/store';

export interface VoiceSession {
  channelId: string;
  title: string;
  muted: boolean;
  connecting: boolean;
}

let room: Room | null = null;
let session: VoiceSession | null = null;

/** The live session, or null. Read from components; changes poke the store. */
export function voiceSession(): VoiceSession | null {
  return session;
}

let audioHost: HTMLDivElement | null = null;
function hostEl(): HTMLDivElement {
  if (!audioHost) {
    audioHost = document.createElement('div');
    audioHost.style.display = 'none';
    document.body.appendChild(audioHost);
  }
  return audioHost;
}

export async function joinVoice(channelId: string): Promise<void> {
  if (session?.channelId === channelId) return;
  await leaveVoice();

  const title = getState().conversations.get(channelId)?.title ?? 'voice';
  session = { channelId, title, muted: false, connecting: true };
  mutate(() => {});

  try {
    const res = await api<{ token: string; url: string }>(
      `/conversations/${channelId}/voice/join`,
      { method: 'POST' },
    );

    // The SFU client is ~150KB gzipped — loaded the first time someone
    // actually joins voice, never on the way to reading messages.
    const { Room, RoomEvent, Track } = await import('livekit-client');
    const r = new Room();
    room = r;
    r.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) hostEl().appendChild(track.attach());
    });
    r.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const el of track.detach()) el.remove();
    });
    r.on(RoomEvent.Disconnected, () => {
      // The SFU dropped us (network, room collected). Reflect reality.
      if (session?.channelId === channelId) {
        session = null;
        room = null;
        mutate(() => {});
      }
    });

    await r.connect(res.url, res.token);
    await r.localParticipant.setMicrophoneEnabled(true);
    if (session?.channelId === channelId) {
      session.connecting = false;
      mutate(() => {});
    }
  } catch (err) {
    console.error('voice join failed', err);
    session = null;
    room = null;
    mutate(() => {});
    void api(`/conversations/${channelId}/voice/leave`, { method: 'POST' }).catch(() => {});
  }
}

export async function leaveVoice(): Promise<void> {
  const leaving = session;
  if (!leaving) return;
  session = null;
  const r = room;
  room = null;
  mutate(() => {});
  try {
    await r?.disconnect();
  } catch {
    /* already gone */
  }
  void api(`/conversations/${leaving.channelId}/voice/leave`, { method: 'POST' }).catch(() => {});
}

export async function toggleVoiceMute(): Promise<void> {
  if (!session || !room) return;
  session.muted = !session.muted;
  mutate(() => {});
  try {
    await room.localParticipant.setMicrophoneEnabled(!session.muted);
  } catch {
    /* mic hardware said no; the flag still reflects intent */
  }
}
