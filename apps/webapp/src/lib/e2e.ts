import { ENCRYPTED_NOTICE, MESSAGE_FORMATS, chooseFormat } from '@yappy/shared';
import { api, currentDeviceId } from './api';
import type { RecipientBundle } from './cipher';
import { beginSession, openSealed, readFormats, sealWith, sealedSender } from './cipher';
import { e2eAvailable } from './e2eFlags';
import { consumePreKey, loadIdentity } from './keys';
import { recall, remember } from './plaintext';
import { loadSession, withSession } from './sessions';

/**
 * The session layer: who a message gets sealed to, what this device can open,
 * and where the answer is kept.
 *
 * The cipher is in `cipher.ts` and the ratchet under it in `ratchet.ts`. What
 * lives here is everything that has to touch the network or the disk: claiming
 * the prekeys that start a session, fetching the identity key a signature is
 * checked against, holding one lock per device so two sends cannot step the
 * same ratchet twice, and writing down what a message said — because with a
 * ratchet, that is the only copy that survives.
 */

/*
 * The flags themselves live in `e2eFlags.ts`, which imports nothing. Anything
 * that only needs to *ask* whether a room is private should import them from
 * there — reaching them through this module pulls the whole cipher with it.
 * Re-exported here so the existing callers read the same way.
 */
export { e2eAvailable, isPrivate, setPrivate } from './e2eFlags';

export interface Envelope {
  deviceId: string;
  ciphertext: string;
}

// ─── the identity keys of everybody else ─────────────────────────────────────

/** One device, as the directory describes it and this client believes it. */
interface DeviceProfile {
  identityKey: string;
  /** Verified against that key, or the oldest format if it did not verify. */
  formats: number[];
}

interface DirectoryEntry {
  fetchedAt: number;
  byDevice: Map<string, DeviceProfile>;
}

const directory = new Map<string, DirectoryEntry>();
/** Long enough that reading a screenful of history is one request per person. */
const DIRECTORY_TTL = 5 * 60 * 1000;

/**
 * Everything the directory says about one person's devices.
 *
 * Refetched when a message names a device the cache has never seen — that is
 * exactly what somebody adding a phone looks like from here, and the
 * alternative is that their first message from it is permanently unreadable.
 */
async function devicesOf(userId: string, wanted?: string): Promise<Map<string, DeviceProfile>> {
  const hit = directory.get(userId);
  if (hit && (wanted === undefined || hit.byDevice.has(wanted))) {
    if (Date.now() - hit.fetchedAt < DIRECTORY_TTL) return hit.byDevice;
  }
  try {
    const res = await api<{
      devices: Array<{
        deviceId: string;
        identityKey: string;
        formats: string | null;
        formatsSignature: string | null;
      }>;
    }>(`/keys/user/${userId}`);
    const byDevice = new Map(
      res.devices.map((d) => [
        d.deviceId,
        {
          identityKey: d.identityKey,
          // Checked here, once, rather than at each use: what the rest of
          // this file sees is a list the device itself signed.
          formats: readFormats(d.formats, d.formatsSignature, d.identityKey),
        },
      ]),
    );
    directory.set(userId, { fetchedAt: Date.now(), byDevice });
    return byDevice;
  } catch {
    return hit?.byDevice ?? new Map();
  }
}

/** The identity key a device publishes, which is what its signatures are checked against. */
async function identityKeyOf(userId: string, deviceId: string): Promise<string | null> {
  return (await devicesOf(userId, deviceId)).get(deviceId)?.identityKey ?? null;
}

// ─── sealing ─────────────────────────────────────────────────────────────────

/**
 * Bundles for the devices this one has never spoken to.
 *
 * Every claim consumes a one-time prekey from every device it returns, so it
 * asks only about the devices that still need one. A conversation that has been
 * running for a while claims nothing at all: the ratchet has taken over, and
 * the pool is left for the people who have not started yet.
 */
async function bundlesFor(userIds: string[], deviceIds: string[]): Promise<RecipientBundle[]> {
  if (deviceIds.length === 0) return [];
  const res = await api<{ bundles: RecipientBundle[] }>('/keys/claim', {
    method: 'POST',
    body: { userIds, deviceIds },
  });
  return res.bundles;
}

/**
 * What a private send puts on the wire.
 *
 * `content` carries the notice rather than the message — see
 * `messages.isEncrypted` on the server for why it is not left empty — and the
 * body goes one copy per device, each under its own ratchet.
 *
 * Own devices included — a message sent from a laptop has to be readable on the
 * phone — but not the device doing the sending, which cannot hold a ratchet
 * session with itself and writes down what it said instead.
 *
 * Returns null when there is nobody to encrypt to, which is not an error: it
 * means every recipient device is one this build has no usable keys for, and
 * the caller should send in the clear rather than post something nobody can
 * read.
 */
export async function sealFor(
  memberIds: string[],
  plaintext: string,
): Promise<{ content: string; envelopes: Envelope[]; plaintext: string } | null> {
  if (!e2eAvailable()) return null;
  try {
    const identity = await loadIdentity();
    if (!identity || identity.deviceId !== currentDeviceId()) return null;

    /**
     * Nobody but us in the recipient list means the caller could not work out who
     * the message is for — a group, where the client holds no full membership. A
     * send like that would seal to this account's own devices and post something
     * the rest of the room could never read, so it goes out in the clear instead,
     * which is what a group message already is.
     */
    if (!memberIds.some((id) => id !== identity.userId)) return null;

    const sender = {
      deviceId: identity.deviceId,
      userId: identity.userId,
      identityPrivate: identity.identityPrivate,
    };

    /**
     * Who exists, and what each of them can read.
     *
     * A device that speaks nothing this build can write gets no copy at all.
     * That is better than the alternative — a message sealed in a format the
     * recipient cannot parse is indistinguishable from a corrupted one, and
     * the ratchet has already thrown away the key by the time anybody notices.
     */
    const devices: Array<{ deviceId: string; format: number }> = [];
    for (const userId of memberIds) {
      for (const [deviceId, profile] of await devicesOf(userId)) {
        const format = chooseFormat(MESSAGE_FORMATS, profile.formats);
        if (format !== null) devices.push({ deviceId, format });
      }
    }
    /**
     * Everybody's devices except this one.
     *
     * A ratchet cannot talk to itself: one session record holds one sending
     * chain and one receiving chain, and a device sealing to its own session
     * would step the first and then try to read the message with the second.
     * The sender's own *other* devices are genuine strangers and get their
     * copies; the sending device writes down what it said instead, which the
     * ratchet already forces it to do for everything else.
     */
    const targets = devices.filter((d) => d.deviceId !== sender.deviceId);
    const unknown: string[] = [];
    for (const { deviceId } of targets) {
      if (!(await loadSession(deviceId))) unknown.push(deviceId);
    }
    const bundles = new Map(
      (await bundlesFor(memberIds, unknown)).map((b) => [b.deviceId, b] as const),
    );

    const envelopes: Envelope[] = [];
    for (const { deviceId, format } of targets) {
      const envelope = await withSession(deviceId, async (existing) => {
        let session = existing;
        if (!session) {
          const bundle = bundles.get(deviceId);
          if (!bundle) return { session: null, result: null };
          try {
            session = beginSession(bundle);
          } catch {
            // A device whose prekey does not verify. Dropped on its own — that
            // is one bad device, and everybody else is still owed their copy.
            return { session: null, result: null };
          }
        }
        const sealed = sealWith(session, plaintext, sender, format);
        return { session: sealed?.session ?? null, result: sealed?.envelope ?? null };
      });
      if (envelope) envelopes.push({ deviceId, ciphertext: envelope });
    }

    return envelopes.length > 0 ? { content: ENCRYPTED_NOTICE, envelopes, plaintext } : null;
  } catch {
    return null;
  }
}

// ─── opening ─────────────────────────────────────────────────────────────────

/**
 * What this device can read of an encrypted message.
 *
 * Asked of the local store first, and that is not an optimisation. A ratchet
 * destroys a message key as it uses it, so a ciphertext opens exactly once on
 * this device, ever. What was written down the first time is the only copy that
 * survives a reload — see `plaintext.ts`.
 *
 * `authorId` is the server's word for who wrote it, and the signature has to
 * agree with it: a sealed body lifted from one message and hung under another
 * name fails here rather than being shown under the wrong face.
 */
export async function decrypt(
  messageId: string,
  ciphertext: string | null | undefined,
  authorId: string,
): Promise<string | null> {
  const known = await recall(messageId);
  if (known !== null) return known;
  if (!ciphertext) return null;

  const claim = sealedSender(ciphertext);
  if (!claim || claim.userId !== authorId) return null;

  const identity = await loadIdentity();
  if (!identity || identity.deviceId !== currentDeviceId()) return null;

  const senderKey = await identityKeyOf(claim.userId, claim.deviceId);
  if (!senderKey) return null;

  const me = {
    deviceId: identity.deviceId,
    signedPreKeyId: identity.signedPreKeyId,
    signedPreKeyPrivate: identity.signedPreKeyPrivate,
    preKeys: identity.preKeys,
  };

  const opened = await withSession(claim.deviceId, async (session) => {
    const result = openSealed(ciphertext, session, me, senderKey, authorId);
    return { session: result?.session ?? null, result };
  });
  if (!opened) return null;

  // Written down before anything else. A message that displays once and is
  // blank after a reload is worse than one that never displayed.
  await remember(messageId, opened.plaintext);

  // And only then is the prekey that started this session spent. In the other
  // order, a crash between the two would leave a message nobody can ever read.
  if (opened.consumedPreKeyId !== null) await consumePreKey(opened.consumedPreKeyId);
  return opened.plaintext;
}

/** A sender knows what it said; it should not have to open its own copy to prove it. */
export async function rememberOwn(messageId: string, plaintext: string): Promise<void> {
  await remember(messageId, plaintext);
}
