/**
 * How the composer's Enter key behaves.
 *
 * Client-local rather than a server setting, deliberately: it is a fact about
 * this keyboard, not about the account. Enter-to-send on a desktop web app and
 * on a phone are different questions — the phones already treat the return key
 * as a newline and put sending on a button — so syncing one answer across
 * devices would export a laptop's habit to places it does not apply.
 *
 * Default on, which is what every chat app trains. Off is for the people who
 * write multi-line messages or paste code — where an accidental send
 * mid-fence is exactly the misfire this exists to stop — and for them
 * Ctrl+Enter (⌘+Enter on a Mac) always sends, in either mode.
 */

const KEY = 'yappy.enterSends';

export function enterSends(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false';
  } catch {
    // Blocked storage reads as the default, same as everywhere else.
    return true;
  }
}

export function setEnterSends(value: boolean): void {
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    /* holds for this session only */
  }
}

/** Whether this keydown should send, under the current preference. */
export function shouldSend(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  if (e.key !== 'Enter') return false;
  // Ctrl/⌘+Enter always sends — the escape hatch that works in both modes.
  if (e.ctrlKey || e.metaKey) return true;
  return enterSends() && !e.shiftKey;
}
