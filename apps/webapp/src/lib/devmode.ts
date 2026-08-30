/**
 * Developer mode: a local switch, not an account property.
 *
 * It unlocks tooling (the bot console, copy-message-JSON), never capability —
 * everything it exposes is REST the account could already call. That is why
 * it can live in localStorage without ceremony.
 */

const KEY = 'yappy.devmode';

export function devModeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the toggle just does not persist */
  }
}
