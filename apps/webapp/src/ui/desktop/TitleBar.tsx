import { desktopClose, desktopMinimize, desktopToggleMaximize } from '../../lib/desktop';
import './titlebar.css';

/**
 * The desktop shell's own titlebar — the window is frameless, so this strip
 * is the chrome: brand on the left, window controls on the right, and the
 * whole bar a drag region (`data-tauri-drag-region` also gives double-click
 * maximize for free). Close hides to the tray; the Rust side enforces that.
 */
export function TitleBar() {
  return (
    <div className="tb" data-tauri-drag-region>
      <span className="tb-brand brand" data-tauri-drag-region>
        yappy
      </span>
      <div className="tb-controls">
        <button className="tb-btn" title="Minimise" aria-label="Minimise" onClick={desktopMinimize}>
          <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.4">
            <path d="M1 5.5h9" />
          </svg>
        </button>
        <button
          className="tb-btn"
          title="Maximise"
          aria-label="Maximise"
          onClick={desktopToggleMaximize}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.4" fill="none">
            <rect x="1.5" y="1.5" width="8" height="8" rx="1.6" />
          </svg>
        </button>
        <button className="tb-btn close" title="Close to tray" aria-label="Close to tray" onClick={desktopClose}>
          <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.4">
            <path d="M1.6 1.6l7.8 7.8M9.4 1.6l-7.8 7.8" />
          </svg>
        </button>
      </div>
    </div>
  );
}
