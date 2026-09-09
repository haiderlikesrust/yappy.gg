import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'yappy.theme';
const EVENT = 'yappy:appearance';
let memoryTheme: Theme | undefined;
/**
 * Dark unless the person says otherwise — not "system". The two themes are
 * different designs, not one design in two exposures, and the app should
 * meet people as one thing rather than as whatever the OS was set to. Dark
 * is the brand's own colour and the same default the phones ship with.
 */
export function readTheme(): Theme {
  if (memoryTheme) return memoryTheme;
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch {
    return 'dark';
  }
}
function applyTheme() {
  const theme = readTheme();
  const resolved =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'light' ? '#eeebf5' : '#232030');
}
export function setTheme(theme: Theme) {
  memoryTheme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Storage may be disabled. */
  }
  applyTheme();
  window.dispatchEvent(new Event(EVENT));
}
export function initAppearance() {
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) {
      memoryTheme = undefined;
      applyTheme();
    }
  });
}
function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}
export const useTheme = () => useSyncExternalStore(subscribe, readTheme);

export function clampSidebarWidth(value: number): number {
  return Number.isFinite(value) ? Math.min(480, Math.max(280, value)) : 348;
}
