import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Escape goes one step back, as it does in a dialog. Used by the views that hold no work of
 * the student's: a file preview and Settings. (A flashcard round or a half-answered quiz is
 * work, so the Study screen is left only with its back button.)
 *
 * Left alone while something else owns Escape: an open dialog, menu or list, or a text field.
 */
export function useEscape(onEscape: () => void): void {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // `data-trigger` is on every open popover (a menu, the list of a select).
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-trigger]')) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable='true'], [aria-expanded='true']")) return;
      latest.current();
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);
}

/**
 * Puts the keyboard focus on a screen's heading when the screen appears, so the next Tab starts
 * at the top of the new screen and a screen reader says where the student now is. Waits for a
 * closing dialog to hand its focus back first, and never takes focus out of an open one.
 */
export function useFocusOnMount(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const dialogOpen = document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
      if (dialogOpen && tries < 60) {
        tries += 1;
        frame = requestAnimationFrame(attempt);
        return;
      }
      const active = document.activeElement;
      // Only when focus is nowhere, or on something that is no longer part of this screen.
      if (!dialogOpen && (active === null || active === document.body || !active.isConnected)) {
        ref.current?.focus({ preventScroll: true });
      }
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [ref]);
}
