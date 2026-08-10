import { RoomServiceClient } from 'livekit-server-sdk';

/**
 * The worker's read-only view of the SFU, for reconciliation.
 *
 * The API is the writer — it creates rooms and deletes them. The worker only
 * ever asks "who is actually in this room?", because the database's answer
 * and LiveKit's answer drift the moment an app dies without saying /leave,
 * and the database is the one that lies.
 */
let client: RoomServiceClient | null | undefined;

function roomService(): RoomServiceClient | null {
  if (client !== undefined) return client;
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  client = url && key && secret
    ? new RoomServiceClient(url.replace(/^ws/, 'http'), key, secret)
    : null;
  return client;
}

/**
 * Identities present in the room right now.
 *
 * Three-valued on purpose:
 *  - `string[]`  — the room's actual roster (identities are our user ids)
 *  - `[]`        — the room does not exist, which for reconciliation means
 *                  "nobody is connected"
 *  - `null`      — no verdict: LiveKit is unreachable or unconfigured, and a
 *                  reconciler with no evidence must not end anything.
 */
export async function participantsIn(roomName: string): Promise<string[] | null> {
  const svc = roomService();
  if (!svc) return null;

  try {
    const list = await svc.listParticipants(roomName);
    return list.map((p) => p.identity);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist')) return [];
    return null;
  }
}
