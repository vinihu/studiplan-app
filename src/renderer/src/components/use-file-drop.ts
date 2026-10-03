import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";

/** True when the thing being dragged is files from the computer (not text or a link). */
export function carriesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export interface FileDrop<Target> {
  /** What the files would land on right now, or `null` when nothing is being dragged over. */
  over: Target | null;
  /** Spread onto the element that accepts the drop. */
  handlers: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
}

/**
 * Makes an element a place to drop files.
 *
 * `targetAt` says what the pointer is over (a material row, or the whole screen) and returns
 * `null` where a drop means nothing. `over` drives the highlight; `onDrop` gets the files in
 * the order the system gave them.
 */
export function useFileDrop<Target>(options: {
  targetAt: (element: Element) => Target | null;
  isSame: (a: Target, b: Target) => boolean;
  onDrop: (target: Target, files: File[]) => void;
  disabled?: boolean;
}): FileDrop<Target> {
  const { targetAt, isSame, onDrop, disabled = false } = options;
  const [over, setOver] = useState<Target | null>(null);
  // dragenter/dragleave fire for every child element; only the last leave means "left".
  const depth = useRef(0);

  const update = useCallback(
    (next: Target | null) => {
      setOver((current) => {
        if (current === null || next === null) return next;
        return isSame(current, next) ? current : next;
      });
    },
    [isSame],
  );

  const accepts = (event: DragEvent<HTMLElement>) => !disabled && carriesFiles(event);

  return {
    over,
    handlers: {
      onDragEnter: (event) => {
        if (!accepts(event)) return;
        depth.current += 1;
      },
      onDragOver: (event) => {
        if (!accepts(event)) return;
        const target = event.target instanceof Element ? targetAt(event.target) : null;
        event.preventDefault();
        event.dataTransfer.dropEffect = target === null ? "none" : "copy";
        update(target);
      },
      onDragLeave: (event) => {
        if (!accepts(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) update(null);
      },
      onDrop: (event) => {
        depth.current = 0;
        update(null);
        if (!accepts(event)) return;
        event.preventDefault();
        const target = event.target instanceof Element ? targetAt(event.target) : null;
        const files = Array.from(event.dataTransfer.files);
        if (target !== null && files.length > 0) onDrop(target, files);
      },
    },
  };
}
