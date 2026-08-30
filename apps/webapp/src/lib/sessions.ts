import { STORES, idbGet, idbPut } from './idb';
import type { Session } from './ratchet';

/**
 * Where ratchet sessions live, and the lock that keeps them coherent.
 *
 * A session is a position in two chains. Two sends that both read it and both
 * write it back leave one of them stepped over: the same message number used
 * twice, and every message after it unreadable at the other end. Nothing about
 * that failure is loud — it looks like the network, until the whole
 * conversation is broken.
 *
 * So every read-modify-write of one device's session goes through [withSession],
 * which serialises them per device. Different devices do not wait on each
 * other; a fan-out to six devices is still six concurrent seals.
 */

/** One promise chain per device, so its session is only ever held by one caller. */
const queues = new Map<string, Promise<unknown>>();

export async function loadSession(deviceId: string): Promise<Session | null> {
  return idbGet<Session>(STORES.sessions, deviceId);
}

export async function saveSession(session: Session): Promise<void> {
  await idbPut(STORES.sessions, session.deviceId, session);
}

/**
 * Hold one device's session for the length of an operation.
 *
 * The callback is handed whatever is stored — null when this device has never
 * been spoken to — and returns the session to store along with whatever the
 * caller wanted. Returning a null session leaves what was there alone, which is
 * what a failed decrypt should do: a ratchet that advances on a message nobody
 * could read is a ratchet that has lost its place.
 */
export async function withSession<T>(
  deviceId: string,
  fn: (session: Session | null) => Promise<{ session: Session | null; result: T }>,
): Promise<T> {
  const previous = queues.get(deviceId) ?? Promise.resolve();
  const run = previous.then(async () => {
    const current = await loadSession(deviceId);
    const { session, result } = await fn(current);
    if (session) await saveSession(session);
    return result;
  });

  // The queue keeps going even when this link fails, or one thrown error would
  // wedge every later message to that device.
  queues.set(
    deviceId,
    run.catch(() => undefined),
  );
  return run;
}
