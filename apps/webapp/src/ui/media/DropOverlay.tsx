import { Icon } from '../icons';
import './media.css';

/**
 * The "drop files to attach" veil. Render inside the drop target (which needs
 * `position: relative`) while `useFileDrop().isDragging` is true. It is
 * pointer-transparent so drop events still reach the container beneath it.
 */
export function DropOverlay(props: { label?: string }) {
  return (
    <div className="drop-overlay" aria-hidden>
      <Icon name="image" size={32} />
      <span>{props.label ?? 'Drop files to attach'}</span>
    </div>
  );
}
