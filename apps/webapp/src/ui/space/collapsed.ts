/**
 * Which categories this person has collapsed.
 *
 * Kept in localStorage rather than on the server, because it is a view
 * preference and not a fact about the space: two people looking at the same
 * sidebar should be able to disagree about which halves of it are folded away,
 * and neither should have to wait for a round trip to find out. It also means
 * a collapse survives a reload without the list flickering open first.
 *
 * Stored as a flat set of category ids across every space — ids are unique, so
 * there is nothing to be gained by nesting them per space, and a flat set
 * makes the stale-id problem self-solving: a category that no longer exists is
 * simply never asked about again.
 */

const KEY = 'yappy.collapsedCategories';

const load = (): Set<string> => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    // Private windows and blocked site data both throw here. A sidebar that
    // renders fully expanded is the right failure.
    return new Set();
  }
};

let collapsed = load();

/** Everyone currently rendering a channel list, so a toggle repaints them. */
const listeners = new Set<() => void>();

export const isCollapsed = (categoryId: string): boolean => collapsed.has(categoryId);

export function toggleCollapsed(categoryId: string): void {
  const next = new Set(collapsed);
  if (!next.delete(categoryId)) next.add(categoryId);
  collapsed = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* the fold still works this session; it just will not survive a reload */
  }
  for (const notify of listeners) notify();
}

export function onCollapseChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
