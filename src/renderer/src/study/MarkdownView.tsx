import { Button, Separator } from "@heroui/react";
import { Fragment, memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { parseMarkdown, splitDocument } from "./markdown";
import type { Align, Block, Inline, List } from "./markdown";

/**
 * Draws a parsed Markdown tree. The second half of rendering untrusted text safely (the first
 * is `markdown.ts`): every string from the tree goes into a React text node. There is no
 * `dangerouslySetInnerHTML` here and no element whose tag, attribute name or style comes from
 * the text. The only attribute that carries model-written text is a link's `href`, already
 * limited to http, https and mailto by the parser.
 *
 * Links open outside the app: `target="_blank"` hands them to the main process, which sends
 * http(s) to the system browser and refuses everything else. The address is shown as the
 * link's tooltip, because the label is whatever the model wrote; where the label could be read
 * as another address than the real one, the real one is written next to it.
 *
 * A document is read a part at a time (`splitDocument`: about 30,000 characters, some ten pages).
 * A summary is one part and is simply shown. Something far longer (a body can be 2,000,000
 * characters, written by anyone) shows its first part and a button for the next, so opening it
 * never parses or draws more than one part's worth at once.
 */
export function MarkdownView({ source }: { source: string }) {
  const parts = useMemo(() => splitDocument(source), [source]);
  const [shown, setShown] = useState(1);
  const visible = Math.min(shown, parts.length);
  return (
    <>
      {parts.slice(0, visible).map((part, index) => (
        <Part key={index} source={part} />
      ))}
      {visible < parts.length ? (
        <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-separator pt-6" data-testid="markdown-more">
          <Button variant="outline" onPress={() => setShown(visible + 1)}>
            Show more
          </Button>
          <p className="text-sm text-muted tabular-nums">
            This is a long document. Part {visible} of {parts.length} is shown.
          </p>
        </div>
      ) : null}
    </>
  );
}

/** One part, parsed once: showing the next part does not read the earlier ones again. */
const Part = memo(function Part({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <Blocks blocks={blocks} />;
});

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
}

const ALIGN: Record<Exclude<Align, null>, string> = {
  left: "text-start",
  center: "text-center",
  right: "text-end",
};

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      // The screen's own title is the h1, so a summary's "#" starts at h2.
      const content = <Inlines nodes={block.children} />;
      if (block.level === 1) {
        return (
          <h2 className="mt-12 mb-4 text-xl leading-7 font-semibold tracking-tight text-balance first:mt-0">
            {content}
          </h2>
        );
      }
      if (block.level === 2) {
        return (
          <h3 className="mt-10 mb-3 text-lg leading-7 font-semibold tracking-tight text-balance first:mt-0">
            {content}
          </h3>
        );
      }
      if (block.level === 3) {
        return <h4 className="mt-8 mb-2 text-base leading-7 font-semibold first:mt-0">{content}</h4>;
      }
      return <h5 className="mt-6 mb-2 text-sm leading-6 font-semibold text-muted first:mt-0">{content}</h5>;
    }
    case "paragraph":
      return (
        <p className="mb-5 last:mb-0">
          <Inlines nodes={block.children} />
        </p>
      );
    case "list":
      return <ListView list={block.list} top />;
    case "quote":
      return (
        <blockquote className="mb-5 border-s border-foreground ps-5 text-muted last:mb-0">
          <Blocks blocks={block.children} />
        </blockquote>
      );
    case "code":
      return (
        <pre
          className="scrollbar mb-5 overflow-x-auto rounded-md border border-separator bg-surface-secondary px-4 py-3 font-mono text-[0.8125rem] leading-6 last:mb-0"
          // A scrolling region has to be reachable without a mouse.
          tabIndex={0}
          aria-label={block.language ? `Code, ${block.language}` : "Code"}
        >
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <Separator className="my-10" />;
    case "table":
      return (
        <div className="scrollbar mb-5 overflow-x-auto last:mb-0" tabIndex={0} role="group" aria-label="Table">
          <table className="w-full border-collapse text-start text-[0.9375rem] leading-6">
            <thead>
              <tr>
                {block.header.map((cell, c) => (
                  <th
                    key={c}
                    scope="col"
                    className={`border-b border-foreground py-2 pe-6 align-bottom font-semibold last:pe-0 ${ALIGN[block.align[c] ?? "left"]}`}
                  >
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className={`border-b border-separator py-2 pe-6 align-top last:pe-0 ${ALIGN[block.align[c] ?? "left"]}`}
                    >
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function ListView({ list, top = false }: { list: List; top?: boolean }) {
  const items = list.items.map((item, index) => (
    <li key={index} className="ps-1.5 marker:text-muted">
      <Inlines nodes={item.children} />
      {item.lists.map((child, c) => (
        <ListView key={c} list={child} />
      ))}
    </li>
  ));
  const spacing = top ? "mb-5 last:mb-0" : "mt-2";
  return list.ordered ? (
    <ol start={list.start} className={`${spacing} flex list-decimal flex-col gap-2 ps-6 marker:tabular-nums`}>
      {items}
    </ol>
  ) : (
    <ul className={`${spacing} flex list-disc flex-col gap-2 ps-6`}>{items}</ul>
  );
}

function Inlines({ nodes }: { nodes: readonly Inline[] }): ReactNode {
  return nodes.map((node, index) => <InlineView key={index} node={node} />);
}

function InlineView({ node }: { node: Inline }): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "strong":
      return (
        <strong className="font-semibold">
          <Inlines nodes={node.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines nodes={node.children} />
        </em>
      );
    case "del":
      return (
        <del>
          <Inlines nodes={node.children} />
        </del>
      );
    case "code":
      return (
        // A formula in backticks: its own face and a quiet ground, and never broken inside a symbol.
        <code className="rounded-xs bg-surface-tertiary px-1 py-0.5 font-mono text-[0.875em] [overflow-wrap:anywhere]">{node.text}</code>
      );
    case "link":
      return (
        <>
          {/* A plain anchor: the address is the tooltip, because the label is whatever the model wrote. */}
          <a
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={node.href}
            className="rounded-xs text-link underline decoration-accent/40 underline-offset-4 outline-none hover:decoration-accent focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Inlines nodes={node.children} />
          </a>
          {/* The label names another address than the one the link opens: say which it is. */}
          {node.reveal ? (
            <span className="text-[0.875em] text-muted" data-testid="link-reveal">
              {" "}
              ({node.reveal})
            </span>
          ) : null}
        </>
      );
    case "image":
      // Never drawn as a picture: loading it would be a request to someone's server. The alt text stands in.
      return node.alt === "" ? null : <Fragment>{node.alt}</Fragment>;
    case "break":
      return <br />;
  }
}
