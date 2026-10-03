import { MarkdownView } from "./MarkdownView";

/**
 * A summary, an explanation or a note, for reading: one column at a comfortable measure, set a
 * step larger and looser than the rest of the app. The body is Markdown from a model and is
 * drawn as text only (see `markdown.ts`).
 *
 * `dense` is for a cheat sheet, which is looked things up in rather than read through: a wider
 * column so its tables have room, type one step smaller, and less air between its blocks, so
 * a page of terms and formulas stays one page. Only spacing and size change; every element is
 * drawn by the same `MarkdownView`.
 */
export function SummaryReader({ body, dense = false }: { body: string; dense?: boolean }) {
  return (
    <article
      dir="auto"
      data-reader={dense ? "dense" : "reading"}
      className={
        dense
          ? `max-w-[48rem] text-[0.9375rem] leading-[1.6] wrap-break-word ${DENSE}`
          : "max-w-[37rem] text-base leading-[1.75] wrap-break-word"
      }
    >
      <MarkdownView source={body} />
    </article>
  );
}

/** A cheat sheet's rhythm: headings closer to what they head, lists and tables tight. */
const DENSE = [
  "[&_h2]:mt-8 [&_h2]:mb-2.5 [&_h2]:text-lg",
  "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base",
  "[&_h4]:mt-5 [&_h4]:mb-1.5 [&_h4]:text-[0.9375rem]",
  "[&_p]:mb-3 [&_ul]:mb-3 [&_ol]:mb-3 [&_ul]:gap-1 [&_ol]:gap-1 [&_li_ul]:mt-1 [&_li_ol]:mt-1 [&_li_ul]:mb-0 [&_li_ol]:mb-0",
  "[&_table]:text-sm [&_th]:py-1.5 [&_td]:py-1.5 [&_th]:pe-5 [&_td]:pe-5",
].join(" ");
