import { useRef } from 'react';
import { clampSidebarWidth } from '../lib/appearance';

export function SidebarResize({
  width,
  onChange,
}: {
  width: number;
  onChange: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="sidebar-resize"
      role="separator"
      tabIndex={0}
      aria-label="Conversation list width"
      aria-orientation="vertical"
      aria-valuemin={280}
      aria-valuemax={480}
      aria-valuenow={width}
      onDoubleClick={() => onChange(348)}
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        onChange(
          e.key === 'Home'
            ? 280
            : e.key === 'End'
              ? 480
              : clampSidebarWidth(width + (e.key === 'ArrowLeft' ? -20 : 20)),
        );
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (drag.current)
          onChange(clampSidebarWidth(drag.current.width + e.clientX - drag.current.x));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
}
