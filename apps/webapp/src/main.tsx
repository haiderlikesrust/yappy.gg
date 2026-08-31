import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getState } from './state/store';
import { armAppLock } from './lib/applock';
import { isDesktop } from './lib/desktop';
import { LockScreen } from './ui/LockScreen';
import { TitleBar } from './ui/desktop/TitleBar';
import { UpdatePill } from './ui/desktop/UpdatePill';
import './styles.css';

// Inside the desktop shell the window is frameless: the app draws its own
// titlebar and the layout flexes underneath it.
if (isDesktop) document.documentElement.classList.add('desktop');

// Before the first render: a passcode set on this device means the app opens
// locked, not locked a moment after you have already read the last message.
armAppLock();

// Read-only debug handle: `yappy.state()` in the console. One honest look at
// the live store beats an evening of screenshot archaeology.
//
// Attached from the store's own module rather than fetched through a dynamic
// import: the store is in the entry chunk anyway — every screen imports it —
// so the import() bought nothing and cost the bundler a boundary it then had
// to warn about.
(window as { yappy?: unknown }).yappy = {
  state: getState,
  // Bumped by hand when it matters: proves which bundle a tab is running.
  build: 'web-speed-2026-08-31',
};

/**
 * The last line of defence. One malformed message must cost one reload, not a
 * blank tab with the error only in a console nobody has open — which is
 * exactly what happened once during development.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('yappy crashed', error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="chat-empty" style={{ flexDirection: 'column', gap: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div>Something broke on our side.</div>
        <button className="btn-accent" style={{ padding: '10px 22px' }} onClick={() => window.location.reload()}>
          Reload yappy
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LockScreen />
    {isDesktop && <TitleBar />}
    {isDesktop && <UpdatePill />}
    <div className="desktop-frame">
      <Boundary>
        <App />
      </Boundary>
    </div>
  </StrictMode>,
);
