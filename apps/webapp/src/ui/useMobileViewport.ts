import { useEffect } from 'react';

/** iOS resizes the visual viewport for its keyboard, while Android can resize the layout. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      if (viewport.scale !== 1) return; // Keep pinch zoom under the browser's control.
      document.documentElement.style.setProperty(
        '--mobile-viewport-height',
        `${viewport.height}px`,
      );
    };
    update();
    viewport.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--mobile-viewport-height');
    };
  }, []);
}
