import { useRef } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { useFocusOnMount } from "./use-escape";

/**
 * The frame of a screen's own content: one readable column with the same margins everywhere,
 * so headings and lists start at the same place on every screen.
 */
export function Page({
  children,
  frame,
  overlay,
}: {
  children: ReactNode;
  /** Props for the whole visible area of the screen, e.g. drop handlers. */
  frame?: HTMLAttributes<HTMLDivElement>;
  /** Drawn over the whole visible area and not scrolled with the content. */
  overlay?: ReactNode;
}) {
  return (
    <div className="relative h-full" {...frame}>
      {/* Room for the scrollbar is kept on both sides, so a long screen starts where a short one does. */}
      <div className="scrollbar h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto flex w-full max-w-4xl flex-col px-10 pt-(--screen-top) pb-16">{children}</div>
      </div>
      {overlay}
    </div>
  );
}

/** A screen's heading: what this is, one quiet line about it, and its actions on the right. */
export function PageHeader({
  above,
  title,
  detail,
  actions,
}: {
  /** The way back, where a screen has one. */
  above?: ReactNode;
  title: string;
  detail?: string | null;
  actions?: ReactNode;
}) {
  // A new screen starts at its heading: for the keyboard and for a screen reader.
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnMount(heading);
  return (
    // In the code the heading comes first, then the way back, then the actions: that is the
    // order Tab takes from the heading. On screen the way back sits above the title.
    <header className="mb-8 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3">
      <div className={`col-start-1 min-w-0 ${above ? "row-start-2" : ""}`}>
        <h1 ref={heading} tabIndex={-1} className="text-2xl leading-8 font-semibold tracking-tight break-words outline-none">
          {title}
        </h1>
        {/* The line keeps its height while loading so the list below does not jump. */}
        <p className="mt-1 min-h-5 text-sm text-muted">{detail}</p>
      </div>
      {above ? <div className="col-span-2 col-start-1 row-start-1 flex min-w-0 flex-col">{above}</div> : null}
      {actions ? (
        <div className={`col-start-2 flex shrink-0 items-center gap-2 ${above ? "row-start-2" : ""}`}>{actions}</div>
      ) : null}
    </header>
  );
}

/** One area of a screen, with its own heading. Material uses one per area: Files, Make, Results. */
export function Section({
  title,
  detail,
  actions,
  children,
}: {
  title: string;
  detail?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center justify-between gap-6">
        <h2 className="flex items-baseline gap-2.5 text-base font-semibold">
          {title}
          {detail ? <span className="text-sm font-normal text-muted">{detail}</span> : null}
        </h2>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
