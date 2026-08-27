import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

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
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
