/**
 * A lock on the app itself.
 *
 * What it is, plainly: a passcode that covers the window when you walk away
 * from it. The phones already have this (`AppLock.kt`, `AppLock.swift`) and
 * ask the fingerprint reader; a browser has no fingerprint reader to ask, so
 * this asks for a passcode instead.
 *
 * What it is not: encryption. Everything the app has fetched is still in
 * memory, and anyone who opens the devtools can read it. The threat this
 * answers is the real one — a person picking up an unlocked laptop, a shared
 * desk, a screen share that outlived its meeting — and it answers exactly
 * that. Saying so is better than implying more.
 *
 * The passcode is never sent anywhere. It is stretched with PBKDF2-SHA256 and
 * only the salt, the iteration count and the digest are stored, so the value
 * on disk cannot be read back into a passcode, and a lock set in this browser
 * has no effect on any other device.
 */

const KEY = 'yappy.applock';
const ITERATIONS = 210_000;

export type LockDelay = 0 | 60 | 300 | 900;

interface LockConfig {
  salt: string;
  hash: string;
  iterations: number;
  /** Seconds out of sight before it locks. 0 = the moment you leave. */
  delay: LockDelay;
}

const state: { config: LockConfig | null; locked: boolean } = { config: read(), locked: false };
const listeners = new Set<() => void>();

function read(): LockConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LockConfig;
    return parsed.salt && parsed.hash ? parsed : null;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function onLockChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export const lockEnabled = (): boolean => state.config !== null;
export const isLocked = (): boolean => state.locked;
export const lockDelay = (): LockDelay => state.config?.delay ?? 0;

const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

async function derive(passcode: string, salt: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function setPasscode(passcode: string, delay: LockDelay = 0): Promise<void> {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derive(passcode, salt, ITERATIONS);
  state.config = { salt, hash, iterations: ITERATIONS, delay };
  localStorage.setItem(KEY, JSON.stringify(state.config));
  state.locked = false;
  emit();
}

export function setDelay(delay: LockDelay): void {
  if (!state.config) return;
  state.config = { ...state.config, delay };
  localStorage.setItem(KEY, JSON.stringify(state.config));
  emit();
}

/** Turning it off needs the passcode, or it is not a lock. */
export async function disableLock(passcode: string): Promise<boolean> {
  if (!(await verify(passcode))) return false;
  state.config = null;
  state.locked = false;
  localStorage.removeItem(KEY);
  emit();
  return true;
}

export async function verify(passcode: string): Promise<boolean> {
  const config = state.config;
  if (!config) return false;
  const hash = await derive(passcode, config.salt, config.iterations);
  // Constant time. It is cheap here and the habit is worth keeping.
  if (hash.length !== config.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i += 1) diff |= hash.charCodeAt(i) ^ config.hash.charCodeAt(i);
  return diff === 0;
}

export async function unlock(passcode: string): Promise<boolean> {
  if (!(await verify(passcode))) return false;
  state.locked = false;
  emit();
  return true;
}

export function lockNow(): void {
  if (!state.config || state.locked) return;
  state.locked = true;
  emit();
}

/**
 * Arm it.
 *
 * Locks on startup whenever a passcode is set — a lock that survives only
 * until the next reload is a screensaver — and again once the window has been
 * out of sight for the chosen delay. The timer starts on `hidden` rather than
 * on the last keystroke, because "away" is the state that matters and a tab
 * open on a second monitor is not away.
 */
export function armAppLock(): void {
  if (state.config) state.locked = true;
  emit();

  let timer: ReturnType<typeof setTimeout> | null = null;

  document.addEventListener('visibilitychange', () => {
    if (!state.config) return;
    if (document.visibilityState === 'hidden') {
      if (state.config.delay === 0) lockNow();
      else timer = setTimeout(lockNow, state.config.delay * 1000);
    } else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.config?.delay === 0) lockNow();
  });
}
