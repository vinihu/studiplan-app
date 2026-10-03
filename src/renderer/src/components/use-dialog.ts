import { useCallback, useState } from "react";

/**
 * Open/closed state for a dialog that is about something (the subject to rename, the file to
 * remove). Closing keeps the last target, so the dialog's text does not change while it
 * animates out.
 */
export interface DialogState<T> {
  isOpen: boolean;
  /** What the dialog is about: the current target, or the last one while closing. */
  target: T | null;
  open: (target: T) => void;
  close: () => void;
}

export function useDialog<T = true>(): DialogState<T> {
  const [state, setState] = useState<{ isOpen: boolean; target: T | null }>({
    isOpen: false,
    target: null,
  });
  const open = useCallback((target: T) => setState({ isOpen: true, target }), []);
  const close = useCallback(() => setState((current) => ({ ...current, isOpen: false })), []);
  return { ...state, open, close };
}
