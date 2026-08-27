/**
 * The desktop (Tauri) bridge.
 *
 * When the web client runs inside the yappy desktop shell, `window.__TAURI__`
 * exists (withGlobalTauri) and the shell owns the window chrome. Everything
 * here degrades to a no-op in an ordinary browser, so no other module needs
 * to know which world it is in.
 */

interface TauriWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}

interface TauriGlobal {
  core: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  window: { getCurrentWindow(): TauriWindow };
  event: {
    listen(name: string, cb: (event: unknown) => void): Promise<() => void>;
  };
}

function tauri(): TauriGlobal | null {
  return (window as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

export const isDesktop = typeof window !== 'undefined' && tauri() !== null;

/** Mirror the unread count onto the taskbar icon. No-op in a browser. */
export function desktopBadge(count: number): void {
  const t = tauri();
  if (!t) return;
  void t.core.invoke('set_badge', { count }).catch(() => {});
}

export function desktopMinimize(): void {
  void tauri()?.window.getCurrentWindow().minimize();
}

export function desktopToggleMaximize(): void {
  void tauri()?.window.getCurrentWindow().toggleMaximize();
}

/** The shell converts close into hide-to-tray; quitting lives in the tray menu. */
export function desktopClose(): void {
  void tauri()?.window.getCurrentWindow().close();
}

/**
 * The shell downloads web updates in the background (Discord model) and
 * fires this when one is staged. Restarting applies it.
 */
export function onDesktopUpdateReady(cb: () => void): void {
  void tauri()?.event.listen('update-ready', cb);
}

/** Restart the shell — the staged bundle becomes current on the way up. */
export function desktopRelaunch(): void {
  void tauri()?.core.invoke('restart_app').catch(() => {});
}
