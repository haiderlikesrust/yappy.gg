import { useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';

/**
 * Drag-and-drop files onto a container.
 *
 * Spread `bind` onto the drop target (usually the whole chat column) and use
 * `isDragging` to show an overlay. Enter/leave are counted because dragging
 * across child elements fires a leave for every boundary crossed.
 *
 *   const { isDragging, bind } = useFileDrop((files) => upload.addFiles(files));
 *   <section {...bind}> … {isDragging && <div className="drop-overlay" />} </section>
 */
export function useFileDrop(onFiles: (files: File[]) => void): {
  isDragging: boolean;
  bind: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
} {
  const [isDragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  const bind = useMemo(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    return {
      onDragEnter(e: DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver(e: DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault(); // without this the browser navigates to the file
      },
      onDragLeave(e: DragEvent) {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop(e: DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) handler.current(files);
      },
    };
  }, []);

  return { isDragging, bind };
}

/**
 * Files pasted from the clipboard (screenshots, copied images).
 *
 * Wire in the composer's textarea:
 *   onPaste={(e) => { const files = filesFromClipboard(e); if (files.length) { e.preventDefault(); upload.addFiles(files); } }}
 *
 * Plain-text pastes return [] so normal typing is untouched. Works with both
 * React's synthetic event and a native ClipboardEvent.
 */
export function filesFromClipboard(e: { clipboardData: DataTransfer | null }): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}
