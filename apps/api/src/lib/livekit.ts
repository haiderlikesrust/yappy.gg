import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { env } from '../env.js';

/**
 * LiveKit is the SFU. It carries the media; this backend carries everything
 * about *who is allowed in* and *who should be ringing*.
 *
 * The division matters: LiveKit has no concept of a blocked user, a group
 * admin, or a phone that is asleep. A join token is only ever minted after our
 * own authorisation has passed, and it is scoped to a single room with an
 * identity we control, so a leaked token cannot be replayed elsewhere.
 */

export const roomServiceUrl = env.LIVEKIT_URL.replace(/^ws/, 'http');

let client: RoomServiceClient | null = null;
export function roomService(): RoomServiceClient {
  client ??= new RoomServiceClient(roomServiceUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return client;
}

export interface JoinTokenOptions {
  roomName: string;
  userId: string;
  /** Shown to other participants — LiveKit has no user directory of its own. */
  displayName: string;
  avatarUrl?: string | null;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  canSubscribe?: boolean;
  isHost?: boolean;
  /** Slightly longer than the ring timeout so a slow answer still works. */
  ttlSeconds?: number;
}

export async function mintJoinToken(opts: JoinTokenOptions): Promise<string> {
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    // Identity is our user id: it is what participant events map back to, and
    // it is what stops two devices of the same user colliding in the room.
    identity: opts.userId,
    name: opts.displayName,
    metadata: JSON.stringify({ avatarUrl: opts.avatarUrl ?? null }),
    ttl: opts.ttlSeconds ?? 3_600,
  });

  token.addGrant({
    room: opts.roomName,
    roomJoin: true,
    canPublish: opts.canPublishAudio || opts.canPublishVideo,
    canSubscribe: opts.canSubscribe ?? true,
    canPublishData: true,
    // Only a host may kick or mute others.
    roomAdmin: opts.isHost ?? false,
    canUpdateOwnMetadata: true,
  });

  return token.toJwt();
}

/** Deterministic from the call id, so a reconnecting client needs no lookup. */
export const roomNameForCall = (callId: string): string => `call_${callId.replace(/-/g, '')}`;

/**
 * Create the room. Production LiveKit runs with `auto_create: false` — its
 * config has always said "rooms are created by the API when a call starts",
 * and this is that create, added after a release where it did not exist and
 * every production call greeted its participants with "requested room does
 * not exist" instead of audio.
 *
 * Idempotent: creating a name that already exists returns the existing room,
 * so the join path can call it as insurance against LiveKit's empty-timeout
 * having collected the room mid-call.
 */
export async function ensureRoom(roomName: string): Promise<void> {
  await roomService().createRoom({
    name: roomName,
    // Longer than the 45s ring so an unanswered room survives to the timeout,
    // and long enough that everyone briefly dropping does not kill the call.
    emptyTimeout: 300,
    maxParticipants: env.CALL_MAX_PARTICIPANTS,
  });
}

export async function closeRoom(roomName: string): Promise<void> {
  try {
    await roomService().deleteRoom(roomName);
  } catch {
    // Already gone, or LiveKit is down. Neither should fail the hangup — the
    // call record is the source of truth for our clients.
  }
}

export async function listParticipants(roomName: string): Promise<string[]> {
  try {
    const list = await roomService().listParticipants(roomName);
    return list.map((p) => p.identity);
  } catch {
    return [];
  }
}
