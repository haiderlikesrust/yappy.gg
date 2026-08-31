/**
 * Whether the tour is owed, and how to ask for it.
 *
 * Three localStorage lines, kept apart from `Tour.tsx` so that asking the
 * question does not load the answer: the shell checks `tourPending()` on
 * every startup and shows the tour to a first-time visitor exactly once, so
 * the overlay itself — its steps, its stylesheet, its measuring — has no
 * business being in the bundle everybody else downloads.
 */

const DONE_KEY = 'yappy.tour.done';

/** Settings fires this to replay the tour from anywhere. */
export const TOUR_EVENT = 'yappy:tour';

export function tourPending(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) !== '1';
  } catch {
    return false;
  }
}

export function markTourDone(): void {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    /* private mode — it will show again, which is harmless */
  }
}

export function requestTour(): void {
  try {
    localStorage.removeItem(DONE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(TOUR_EVENT));
}
