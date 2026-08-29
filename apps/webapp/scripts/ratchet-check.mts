import { x25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { accept, initiate, ratchetDecrypt, ratchetEncrypt } from '../src/lib/ratchet.ts';
import type { RatchetHeader, RecipientPrivates, Session } from '../src/lib/ratchet.ts';

/**
 * The ratchet, against the things that actually go wrong.
 *
 * A ratchet that only works when messages arrive once, in order, immediately,
 * is a ratchet that works in a test and strands people in a tunnel. What is
 * checked here is the rest of it: messages that overtake each other, messages
 * that never arrive, both sides talking at once, the same message delivered
 * twice, and — the property the whole thing exists for — a key that is gone
 * after it has been used.
 *
 *   pnpm --filter @yappy/webapp ratchet-check
 */

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** A device with a prekey pool, both halves. */
function device(deviceId: string, withOneTime = true) {
  const spkPrivate = x25519.utils.randomSecretKey();
  const otkPrivate = x25519.utils.randomSecretKey();

  return {
    deviceId,
    bundle: {
      deviceId,
      signedPreKey: { id: 1, key: toB64(x25519.getPublicKey(spkPrivate)) },
      oneTimePreKey: withOneTime ? { id: 7, key: toB64(x25519.getPublicKey(otkPrivate)) } : null,
    },
    privates: {
      signedPreKeyId: 1,
      signedPreKeyPrivate: toB64(spkPrivate),
      preKeys: { 7: toB64(otkPrivate) },
    } satisfies RecipientPrivates,
  };
}

/** The associated data a real envelope binds; fixed here, and identical both ways. */
const aad = (h: RatchetHeader) => utf8ToBytes(`${h.dh}|${h.pn}|${h.n}`);

interface Wire {
  header: RatchetHeader;
  ciphertext: string;
}

function send(session: Session, text: string): { session: Session; wire: Wire } {
  const out = ratchetEncrypt(session, text, utf8ToBytes('placeholder'));
  if (!out) throw new Error('this session cannot send yet');
  // Re-encrypt with the real associated data now that the header is known —
  // exactly what the envelope does, where the header is part of what is bound.
  const bound = ratchetEncrypt(session, text, aad(out.header));
  if (!bound) throw new Error('unreachable');
  return { session: bound.session, wire: { header: bound.header, ciphertext: bound.ciphertext } };
}

function receive(session: Session, wire: Wire): { session: Session; plaintext: string } | null {
  return ratchetDecrypt(session, wire.header, wire.ciphertext, aad(wire.header));
}

// ─── it works at all ─────────────────────────────────────────────────────────

{
  const bob = device('bob-phone');
  let alice = initiate(bob.bundle);
  const first = send(alice, 'are you there');
  alice = first.session;

  const opened = accept(first.wire.header.pre!, bob.privates, 'alice-laptop');
  check('the preamble builds the other side of the session', opened !== null);

  const read = opened && receive(opened, first.wire);
  check('the first message opens', read?.plaintext === 'are you there');

  // Bob can only speak after hearing: his sending chain does not exist until
  // Alice's ratchet key arrives, which is the point of starting from a prekey.
  const reply = send(read!.session, 'i am');
  const backOnAlice = receive(alice, reply.wire);
  check('the reply opens, through a ratchet turn', backOnAlice?.plaintext === 'i am');

  // And on, through several turns.
  let a = backOnAlice!.session;
  let b = reply.session;
  let conversation = true;
  for (let i = 0; i < 12; i += 1) {
    const fromA = send(a, `a${i}`);
    a = fromA.session;
    const atB = receive(b, fromA.wire);
    if (atB?.plaintext !== `a${i}`) conversation = false;
    b = atB!.session;

    const fromB = send(b, `b${i}`);
    b = fromB.session;
    const atA = receive(a, fromB.wire);
    if (atA?.plaintext !== `b${i}`) conversation = false;
    a = atA!.session;
  }
  check('twelve turns of back and forth', conversation);
}

// ─── the message never arrives in the order it was sent ──────────────────────

{
  const bob = device('bob-2');
  let alice = initiate(bob.bundle);
  const wires: Wire[] = [];
  for (let i = 0; i < 5; i += 1) {
    const out = send(alice, `message ${i}`);
    alice = out.session;
    wires.push(out.wire);
  }

  let session = accept(wires[0]!.header.pre!, bob.privates, 'alice')!;

  // Backwards, which is the worst case: every message but the last is a
  // message from the future when it lands.
  const seen: string[] = [];
  for (const wire of [...wires].reverse()) {
    const read = receive(session, wire);
    if (!read) break;
    session = read.session;
    seen.push(read.plaintext);
  }
  check(
    'five messages arriving backwards all open',
    seen.sort().join(',') === wires.map((_, i) => `message ${i}`).sort().join(','),
    seen.join(','),
  );
}

{
  const bob = device('bob-3');
  let alice = initiate(bob.bundle);
  const wires: Wire[] = [];
  for (let i = 0; i < 4; i += 1) {
    const out = send(alice, `m${i}`);
    alice = out.session;
    wires.push(out.wire);
  }

  // The second one is lost for good; the rest still have to open.
  let session = accept(wires[0]!.header.pre!, bob.privates, 'alice')!;
  const first = receive(session, wires[0]!);
  session = first!.session;
  const third = receive(session, wires[2]!);
  session = third!.session;
  const fourth = receive(session, wires[3]!);
  check(
    'a message that never arrives does not block the ones behind it',
    first?.plaintext === 'm0' && third?.plaintext === 'm2' && fourth?.plaintext === 'm3',
  );

  // And if it turns up much later, it still opens.
  const late = receive(fourth!.session, wires[1]!);
  check('and it still opens if it turns up later', late?.plaintext === 'm1');
}

// ─── both sides talk at once ─────────────────────────────────────────────────

{
  const bob = device('bob-4');
  let alice = initiate(bob.bundle);
  const opening = send(alice, 'hello');
  alice = opening.session;
  let bobSession = accept(opening.wire.header.pre!, bob.privates, 'alice')!;
  bobSession = receive(bobSession, opening.wire)!.session;

  // Neither has heard the other's next message when they send.
  const fromA = send(alice, 'from alice');
  const fromB = send(bobSession, 'from bob');

  const atB = receive(fromB.session, fromA.wire);
  const atA = receive(fromA.session, fromB.wire);
  check(
    'messages that cross in flight both open',
    atB?.plaintext === 'from alice' && atA?.plaintext === 'from bob',
  );

  // And the conversation keeps working afterwards, which is the part that
  // breaks when a ratchet turns on the wrong side.
  const after = send(atA!.session, 'still here');
  const readAfter = receive(atB!.session, after.wire);
  check('and the conversation survives the crossing', readAfter?.plaintext === 'still here');
}

// ─── what it must refuse ─────────────────────────────────────────────────────

{
  const bob = device('bob-5');
  let alice = initiate(bob.bundle);
  const out = send(alice, 'once');
  alice = out.session;
  let session = accept(out.wire.header.pre!, bob.privates, 'alice')!;

  const first = receive(session, out.wire);
  session = first!.session;
  check('a message opens once', first?.plaintext === 'once');
  check('and not twice — the key is gone', receive(session, out.wire) === null);

  const tampered: Wire = {
    header: out.wire.header,
    ciphertext: Buffer.from(
      (() => {
        const bytes = Buffer.from(out.wire.ciphertext, 'base64');
        bytes[0] ^= 0xff;
        return bytes;
      })(),
    ).toString('base64'),
  };
  const fresh = accept(out.wire.header.pre!, bob.privates, 'alice')!;
  check('a flipped byte does not open', receive(fresh, tampered) === null);

  const misbound = ratchetDecrypt(
    accept(out.wire.header.pre!, bob.privates, 'alice')!,
    out.wire.header,
    out.wire.ciphertext,
    utf8ToBytes('different associated data'),
  );
  check('a header that does not match what was bound does not open', misbound === null);

  check(
    'a preamble naming a prekey this device never had is refused',
    accept({ ek: out.wire.header.pre!.ek, spkId: 1, otkId: 99 }, bob.privates, 'alice') === null,
  );
  check(
    'a preamble naming a rotated signed prekey is refused',
    accept({ ...out.wire.header.pre!, spkId: 2 }, bob.privates, 'alice') === null,
  );

  const farFuture = receive(accept(out.wire.header.pre!, bob.privates, 'alice')!, {
    header: { ...out.wire.header, n: 5000 },
    ciphertext: out.wire.ciphertext,
  });
  check('a header claiming a message far in the future is refused', farFuture === null);
}

// ─── the degraded case, and the boring ones ──────────────────────────────────

{
  const bob = device('bob-6', false);
  let alice = initiate(bob.bundle);
  const out = send(alice, 'no one-time prekey left');
  alice = out.session;
  const session = accept(out.wire.header.pre!, bob.privates, 'alice')!;
  check(
    'a session still starts when the prekey pool is empty',
    receive(session, out.wire)?.plaintext === 'no one-time prekey left',
  );
}

{
  const bob = device('bob-7');
  let alice = initiate(bob.bundle);
  const out = send(alice, 'through storage and back');
  alice = JSON.parse(JSON.stringify(out.session)) as Session;
  const session = JSON.parse(
    JSON.stringify(accept(out.wire.header.pre!, bob.privates, 'alice')),
  ) as Session;
  const read = receive(session, out.wire);
  check('a session survives being stored as json', read?.plaintext === 'through storage and back');

  // The sending side round-trips too: it has to be able to keep talking.
  const next = send(alice, 'and again');
  check(
    'and can still send afterwards',
    receive(read!.session, next.wire)?.plaintext === 'and again',
  );
}

{
  const bob = device('bob-8');
  let alice = initiate(bob.bundle);
  const first = send(alice, 'one');
  alice = first.session;
  const second = send(alice, 'two');

  check(
    'the preamble repeats until they answer',
    first.wire.header.pre !== null && second.wire.header.pre !== null,
  );

  let session = accept(first.wire.header.pre!, bob.privates, 'alice')!;
  session = receive(session, first.wire)!.session;
  const reply = send(session, 'heard you');
  const atAlice = receive(alice, reply.wire)!;
  const third = send(atAlice.session, 'three');
  check('and stops once they have', third.wire.header.pre === null);
}

console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
