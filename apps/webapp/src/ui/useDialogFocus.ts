import { useEffect, useRef } from 'react';

export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (!root) return;
    const controls = () =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter((el) => el.getClientRects().length > 0);
    (controls()[0] ?? root).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (root.matches('[role="dialog"][aria-modal="true"]') && dialogs.item(dialogs.length - 1) !== root) return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (!first) {
        event.preventDefault();
        root.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return ref;
}
