/**
 * Markdown, read into a tree of plain data. No DOM, no React, no HTML.
 *
 * A summary is written by a model and can be edited by anyone, so it is untrusted. This parser
 * is the first half of the answer to that: it only ever produces the node types below, and
 * every node carries its text as a string. Nothing in the tree is markup. `<script>` in a
 * summary is the nine characters `<script>` inside a text node; the renderer (`Markdown.tsx`)
 * puts strings into React text nodes and has no way to do anything else with them.
 *
 * The one place a model-written string becomes an attribute is a link's address, and it only
 * gets there through `safeHref`: `http:`, `https:` and `mailto:`, nothing else. A link with any
 * other address is not a link node at all: its label is kept as ordinary text.
 *
 * Images are never fetched: `![alt](url)` becomes an `image` node holding only the alt text.
 * The address is dropped here, so the renderer could not load it if it wanted to.
 *
 * The subset is what summaries use: headings, paragraphs, bold, italic, strikethrough, inline
 * code, fenced code, ordered / unordered / nested lists, block quotes, rules, pipe tables and
 * links. Anything else stays as the characters that were written.
 *
 * A body can be 2,000,000 characters of anything, so nothing here may cost more than a small
 * multiple of its input:
 *   - every pattern is bounded (`{0,N}`), so a long line of unclosed `*`, `[` or backticks, or a
 *     long run of blanks, cannot make a pattern try the same stretch again and again;
 *   - no count taken from the document sizes an allocation: a table has at most
 *     `MAX_TABLE_COLUMNS` columns and `MAX_TABLE_ROWS` rows;
 *   - no line is longer than `MAX_LINE` (see `tidyLines`).
 * The viewer goes one step further and reads a long document a part at a time (`splitDocument`),
 * so opening it costs what one part costs.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "code"; text: string }
  /**
   * `reveal` is where the link really goes (a host, or a mail address), set only when its label
   * could be read as going somewhere else. The viewer shows it next to the label.
   */
  | { type: "link"; href: string; children: Inline[]; reveal?: string }
  /** An image that is not shown. Only the alt text survives parsing. */
  | { type: "image"; alt: string }
  | { type: "break" };

export interface ListItem {
  children: Inline[];
  /** Lists nested under this item, in the order they were written. */
  lists: List[];
}

export interface List {
  ordered: boolean;
  /** The number an ordered list starts at. */
  start: number;
  items: ListItem[];
}

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; list: List }
  | { type: "quote"; children: Block[] }
  | { type: "code"; text: string; language: string | null }
  | { type: "rule" }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] };

/* ------------------------------------------------------------------ *
 * Links
 * ------------------------------------------------------------------ */

/** One address, nothing else. The same rule as the main process's (`src/main/security.ts`). */
const PLAIN_MAILTO = /^mailto:[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}$/i;

/**
 * The address a link may point at, or `null` when it may not be a link.
 *
 * Parsed with `URL`, the same way the browser will read it, so `JaVaScRiPt:`, a leading
 * control character or `java\tscript:` cannot slip past a string comparison. A relative
 * address has no protocol and is refused: inside the app it would point at the app's own files.
 *
 * The rule is the main process's own (`isSafeExternalUrl`), which has the last word when a link
 * is pressed: what it would refuse is not shown as a link here either.
 *   - a web address has no user name or password in front of its host: that is how
 *     `https://bank.example@evil.example/` is made to look like it goes to the bank;
 *   - a `mailto:` is one plain address, with no subject, body or copies a summary could prefill.
 */
export function safeHref(raw: string): string | null {
  const candidate = raw.trim();
  if (candidate === "" || candidate.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") {
    return candidate.length <= 320 && PLAIN_MAILTO.test(candidate) ? url.href : null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
  return url.href;
}

/**
 * Characters that change the direction text is drawn in. In a link's label they can make
 * `moc.elpmaxe` read as `example.com`; a label has no use for them.
 */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const withoutWww = (host: string): string => host.toLowerCase().replace(/^www\./, "");

/** Something in a label that reads as a web address: `example.com`, `https://example.com/page`. */
const HOST_IN_LABEL = /(?<![\p{L}\p{N}@.-])(?:https?:\/\/)?((?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,24})(?![\p{L}\p{N}-])/giu;
const MAIL_IN_LABEL = /[\p{L}\p{N}._+-]{1,64}@(?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,24}/giu;

/**
 * Where a link really goes, when its label says something else; otherwise `undefined`.
 *
 * The rule, kept small so that ordinary links stay as they are:
 *   - the label names a web address or a mail address, and it is not the link's own (the same
 *     host, with or without `www.`, or a part of it: `example.com` for `docs.example.com`); or
 *   - the host is written in the encoded form of look-alike letters (`xn--…`), which a label
 *     can dress up as any name.
 * A label of plain words ("the course page") reveals nothing: there is nothing to mistake.
 */
export function revealFor(href: string, label: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  const shown = label.slice(0, 2_000);
  if (url.protocol === "mailto:") {
    const address = url.pathname.toLowerCase();
    const named = [...shown.matchAll(MAIL_IN_LABEL)].map((match) => match[0].toLowerCase());
    return named.some((mail) => mail !== address) ? address : undefined;
  }
  const host = withoutWww(url.hostname);
  if (host.split(".").some((part) => part.startsWith("xn--"))) return url.hostname;
  for (const match of shown.matchAll(HOST_IN_LABEL)) {
    const named = withoutWww(match[1] ?? "");
    if (named !== host && !host.endsWith(`.${named}`)) return url.hostname;
  }
  // A label that names a mail address, on a link that opens a web page.
  return shown.match(MAIL_IN_LABEL) !== null ? url.hostname : undefined;
}

function linkNode(href: string, children: Inline[]): Inline {
  const reveal = revealFor(href, inlineText(children));
  return reveal === undefined ? { type: "link", href, children } : { type: "link", href, children, reveal };
}

/* ------------------------------------------------------------------ *
 * Inline
 * ------------------------------------------------------------------ */

/** Nesting deeper than this is kept as text. Bounds recursion on hostile input. */
const MAX_INLINE_DEPTH = 6;
const MAX_BLOCK_DEPTH = 4;
const MAX_LIST_DEPTH = 6;

const ESCAPABLE = "\\\\`*_{}\\[\\]()#+\\-.!|>~<";

// A link's address may hold one level of balanced parentheses, as in `wiki/Foo_(bar)` or the
// `alert(1)` of a refused `javascript:` address, so the closing `)` is always consumed. An
// optional "title" after the address is accepted and dropped.
const LABEL = "\\[((?:[^\\[\\]\\n]|\\[[^\\[\\]\\n]{0,300}\\]){1,1000})\\]";
// Blanks around the address are bounded too: an unbounded `\s*` in front of a lazy group makes
// a long run of blanks (of any kind: a no-break space is one) cost its length squared.
const ADDRESS = "\\(\\s{0,20}<?((?:[^()\\s]|\\([^()\\s]{0,500}\\)){0,2000}?)>?(?:\\s{1,20}\"[^\"\\n]{0,300}\")?\\s{0,20}\\)";

const INLINE = new RegExp(
  [
    `\\\\([${ESCAPABLE}])`, // 1 an escaped character
    // A run of 1 to 4 backticks, the whole run and nothing but it, on both sides. Without the
    // bounds a line of thousands of backticks is tried from every one of them, at every length.
    "(?<!`)(`{1,4})(?!`)([^\\n]{1,2000}?)(?<!`)\\2(?!`)", // 2,3 code
    `!${LABEL.replace("{1,1000}", "{0,1000}")}${ADDRESS}`, // 4,5 image
    `${LABEL}${ADDRESS}`, // 6,7 link
    "<((?:https?:\\/\\/|mailto:)[^\\s<>]{1,2000})>", // 8 autolink
    "\\*\\*\\*(?=\\S)([^*\\n]{1,1000}?)\\*\\*\\*", // 9 bold and italic at once
    "\\*\\*(?=\\S)((?:[^*\\n]|\\*(?!\\*)){1,1000}?)\\*\\*", // 10 bold
    "(?<![\\p{L}\\p{N}_])__(?=\\S)([^\\n]{1,1000}?)__(?![\\p{L}\\p{N}_])", // 11 bold
    "\\*(?=[^\\s*])([^*\\n]{0,1000}?[^\\s*])\\*", // 12 italic
    "(?<![\\p{L}\\p{N}_])_(?=[^\\s_])([^_\\n]{0,1000}?[^\\s_])_(?![\\p{L}\\p{N}_])", // 13 italic
    "~~(?=\\S)([^~\\n]{1,1000}?)~~", // 14 strikethrough
    "(\\n)", // 15 a hard line break, placed by the block parser
    "<br\\s*\\/?>", // a written line break, which models use inside table cells
  ].join("|"),
  "giu",
);

function pushText(out: Inline[], text: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth >= MAX_INLINE_DEPTH) {
    pushText(out, source);
    return out;
  }
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    const start = match.index;
    pushText(out, source.slice(last, start));
    last = start + match[0].length;

    // In the order of the groups in INLINE.
    const [, escaped, ticks, code, imageAlt, imageAddress, label, address, auto, both, bold, boldAlt, italic, italicAlt, struck] =
      match;
    if (escaped !== undefined) {
      pushText(out, escaped);
    } else if (ticks !== undefined && code !== undefined) {
      out.push({ type: "code", text: code.trim() || code });
    } else if (imageAddress !== undefined) {
      out.push({ type: "image", alt: (imageAlt ?? "").trim() });
    } else if (address !== undefined) {
      const href = safeHref(address);
      const children = parseInline((label ?? "").replace(BIDI_CONTROLS, ""), depth + 1);
      if (href) out.push(linkNode(href, children));
      else for (const child of children) appendInline(out, child);
    } else if (auto !== undefined) {
      const href = safeHref(auto);
      if (href) out.push({ type: "link", href, children: [{ type: "text", text: auto }] });
      else pushText(out, match[0]);
    } else if (both !== undefined) {
      out.push({ type: "strong", children: [{ type: "em", children: parseInline(both, depth + 1) }] });
    } else if (bold !== undefined || boldAlt !== undefined) {
      out.push({ type: "strong", children: parseInline(bold ?? boldAlt ?? "", depth + 1) });
    } else if (italic !== undefined || italicAlt !== undefined) {
      out.push({ type: "em", children: parseInline(italic ?? italicAlt ?? "", depth + 1) });
    } else if (struck !== undefined) {
      out.push({ type: "del", children: parseInline(struck, depth + 1) });
    } else {
      out.push({ type: "break" });
    }
  }
  pushText(out, source.slice(last));
  return out;
}

function appendInline(out: Inline[], node: Inline): void {
  if (node.type === "text") pushText(out, node.text);
  else out.push(node);
}

/** The text of a run of inline nodes, as a reader would see it. For tests and labels. */
export function inlineText(nodes: readonly Inline[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text" || node.type === "code") text += node.text;
    else if (node.type === "image") text += node.alt;
    else if (node.type === "break") text += "\n";
    else text += inlineText(node.children);
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`]{0,40})/;
const QUOTE = /^[ \t]*>/;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const HARD_BREAK = /(?: {2,}|\\)$/;

/** Splits a table row on its pipes. `\|` is a pipe inside a cell. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** A wider or longer table is not a table a student reads; what is beyond stays as text. */
const MAX_TABLE_COLUMNS = 30;
const MAX_TABLE_ROWS = 500;

/** No line is longer than this, and no run of blanks inside one. */
const MAX_LINE = 10_000;
const MAX_BLANKS = 200;

/**
 * The lines of a document, made safe to read with patterns:
 *   - a run of `MAX_BLANKS` blanks or more is one blank (several patterns look for "blanks, then
 *     the end of the line", and would walk a long run once from each of its characters);
 *   - a line longer than `MAX_LINE` continues on the next, broken at a blank where there is one
 *     and indented, so it still belongs to its paragraph or list item.
 * A document a student reads has neither; it comes out as it went in.
 */
export function tidyLines(markdown: string): string[] {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .replace(new RegExp(`[ \\t]{${MAX_BLANKS},}`, "g"), " ")
    .split("\n");
  if (lines.every((line) => line.length <= MAX_LINE)) return lines;
  const out: string[] = [];
  for (const line of lines) {
    const indent = /^[ \t]{0,40}/.exec(line)?.[0] ?? "";
    // Walked by position, never by cutting the rest off again and again: one pass over the line.
    let at = 0;
    let prefix = "";
    while (line.length - at + prefix.length > MAX_LINE) {
      const room = MAX_LINE - prefix.length;
      // The last blank in the second half of the stretch; looked for there only, so a line
      // without any blank is not searched from its start at every cut.
      let cut = at + room;
      for (let i = at + room; i > at + room / 2; i -= 1) {
        if (line[i] === " ") {
          cut = i;
          break;
        }
      }
      out.push(prefix + line.slice(at, cut));
      at = cut;
      while (line[at] === " " || line[at] === "\t") at += 1;
      prefix = `${indent}  `;
    }
    out.push(prefix + line.slice(at));
  }
  return out;
}

/** About how much of a document the viewer reads at a time. */
const PART_SIZE = 30_000;

/**
 * A long document in parts of about `PART_SIZE` characters, each of which can be parsed on its
 * own. A part ends at a blank line outside a code block, so no block is cut in two. Where there
 * is no such line for twice that length (one endless paragraph, list or code block), it ends at
 * the end of a line, and a code block is closed and opened again around the cut.
 *
 * A summary of ordinary length is one part.
 */
export function splitDocument(markdown: string, partSize: number = PART_SIZE): string[] {
  const lines = tidyLines(markdown);
  const parts: string[] = [];
  let part: string[] = [];
  let size = 0;
  /** The marker of the code block the current line is inside, or `null`. */
  let fence: string | null = null;
  const end = () => {
    if (part.length > 0) parts.push(part.join("\n"));
    part = [];
    size = 0;
  };
  for (const line of lines) {
    if (fence === null) {
      if (size >= partSize && line.trim() === "") {
        end();
        continue;
      }
      if (size >= partSize * 2) end();
      fence = FENCE.exec(line)?.[1] ?? null;
    } else if (line.trim().startsWith(fence)) {
      fence = null;
    } else if (size >= partSize * 2) {
      part.push(fence);
      end();
      part.push(fence);
    }
    part.push(line);
    size += line.length + 1;
  }
  end();
  return parts.length === 0 ? [""] : parts;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : null;
}

function indentOf(raw: string): number {
  return raw.replace(/\t/g, "    ").length;
}

function isOrdered(marker: string): boolean {
  return /\d/.test(marker);
}

interface ListLine {
  indent: number;
  marker: string;
  text: string;
}

function listLine(line: string): ListLine | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  return { indent: indentOf(match[1] ?? ""), marker: match[2] ?? "-", text: match[3] ?? "" };
}

function newList(marker: string): List {
  return {
    ordered: isOrdered(marker),
    start: isOrdered(marker) ? parseInt(marker, 10) : 1,
    items: [],
  };
}

/** Builds a nested list from consecutive list lines (and their continuation lines). */
function buildList(lines: readonly string[], first: ListLine): List {
  interface Frame {
    indent: number;
    list: List;
    /** The text of each item so far, parsed when the list is complete. */
    texts: string[];
  }
  let frame: Frame = { indent: first.indent, list: newList(first.marker), texts: [] };
  const root = frame.list;
  const frames: Frame[] = [frame];
  /** The open lists above `frame`, outermost first. */
  const parents: Frame[] = [];

  for (const line of lines) {
    const item = listLine(line);
    if (!item) {
      // A continuation line belongs to the last item of the deepest open list.
      if (frame.texts.length > 0) frame.texts[frame.texts.length - 1] += ` ${line.trim()}`;
      continue;
    }
    while (parents.length > 0 && item.indent < frame.indent) frame = parents.pop() ?? frame;

    const deeper = item.indent > frame.indent && frame.list.items.length > 0 && parents.length + 1 < MAX_LIST_DEPTH;
    // "1." after "-" at the same depth of a nested list is a second list under the same item.
    const otherKind =
      item.indent === frame.indent && parents.length > 0 && isOrdered(item.marker) !== frame.list.ordered;
    if (otherKind) frame = parents.pop() ?? frame;
    if (deeper || otherKind) {
      const owner = frame.list.items[frame.list.items.length - 1];
      const child: Frame = { indent: item.indent, list: newList(item.marker), texts: [] };
      owner?.lists.push(child.list);
      parents.push(frame);
      frame = child;
      frames.push(child);
    }
    frame.list.items.push({ children: [], lists: [] });
    frame.texts.push(item.text);
  }

  for (const done of frames) {
    done.list.items.forEach((item, i) => {
      item.children = parseInline(done.texts[i] ?? "");
    });
  }
  return root;
}

// What ends a paragraph without a blank line. A numbered item only does when it is "1.", so a
// wrapped sentence that happens to start a line with "2021. " stays in its paragraph.
function startsBlock(line: string): boolean {
  if (HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = listLine(line);
  return item !== null && (!isOrdered(item.marker) || parseInt(item.marker, 10) === 1);
}

export function parseMarkdown(markdown: string, depth = 0): Block[] {
  const lines = tidyLines(markdown);
  const blocks: Block[] = [];
  /** The line at `index`, or "" past the end. */
  const at = (index: number): string => lines[index] ?? "";
  let i = 0;

  while (i < lines.length) {
    const line = at(i);

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length && !at(i).trim().startsWith(marker)) body.push(at(i++));
      i++; // the closing fence, or the end of the text
      blocks.push({ type: "code", text: body.join("\n"), language: fence[2] || null });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: Math.min(6, Math.max(1, (heading[1] ?? "#").length)) as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (line.includes("|") && at(i + 1).includes("-") && TABLE_DIVIDER.test(at(i + 1))) {
      const header = splitRow(line);
      const divider = splitRow(at(i + 1));
      // Every row is filled up to the header's width, so the width is bounded before anything
      // is made from it: a header of thousands of pipes is not a table.
      if (divider.length === header.length && header.length <= MAX_TABLE_COLUMNS) {
        const rows: Inline[][][] = [];
        i += 2;
        while (rows.length < MAX_TABLE_ROWS && i < lines.length && at(i).trim() !== "" && at(i).includes("|")) {
          const cells = splitRow(at(i++));
          rows.push(header.map((_, c) => parseInline(cells[c] ?? "")));
        }
        blocks.push({
          type: "table",
          align: divider.map(alignOf),
          header: header.map((cell) => parseInline(cell)),
          rows,
        });
        continue;
      }
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(at(i))) {
        body.push(at(i++).replace(/^[ \t]*>[ \t]?/, ""));
      }
      const inner = body.join("\n");
      blocks.push({
        type: "quote",
        children:
          depth + 1 >= MAX_BLOCK_DEPTH
            ? [{ type: "paragraph", children: parseInline(inner.replace(/\n/g, " ")) }]
            : parseMarkdown(inner, depth + 1),
      });
      continue;
    }

    const first = listLine(line);
    if (first) {
      // One list only while its top-level items keep the first item's kind: "1." then "-" at
      // the same depth starts a new list.
      const continuesList = (candidate: string): boolean => {
        const item = listLine(candidate);
        return item !== null && (item.indent > first.indent || isOrdered(item.marker) === isOrdered(first.marker));
      };
      const body: string[] = [];
      while (i < lines.length) {
        const current = at(i);
        if (RULE.test(current)) break;
        if (LIST_ITEM.test(current)) {
          if (!continuesList(current)) break;
          body.push(current);
          i++;
        } else if (current.trim() !== "" && /^[ \t]+/.test(current)) {
          body.push(current); // an indented continuation of the item above
          i++;
        } else if (current.trim() === "" && i + 1 < lines.length && continuesList(at(i + 1))) {
          i++; // a blank line between items keeps one list
        } else {
          break;
        }
      }
      blocks.push({ type: "list", list: buildList(body, first) });
      continue;
    }

    // A paragraph: lines up to a blank line or the start of another block. A line ending in
    // two spaces or a backslash ends with a line break; the others are joined by a space.
    const parts: string[] = [];
    while (i < lines.length) {
      const current = at(i++);
      const hard = HARD_BREAK.test(current);
      parts.push(current.replace(HARD_BREAK, "").trim());
      const more = i < lines.length && at(i).trim() !== "" && !startsBlock(at(i));
      if (!more) break;
      parts.push(hard ? "\n" : " ");
    }
    blocks.push({ type: "paragraph", children: parseInline(parts.join("")) });
  }

  return blocks;
}

/* ------------------------------------------------------------------ *
 * Looking at a tree
 * ------------------------------------------------------------------ */

/** Every inline node of a tree, depth first. For tests: what could the renderer be asked to draw? */
export function collectInline(blocks: readonly Block[]): Inline[] {
  const found: Inline[] = [];
  const walkInline = (nodes: readonly Inline[]): void => {
    for (const node of nodes) {
      found.push(node);
      if ("children" in node) walkInline(node.children);
    }
  };
  const walkList = (list: List): void => {
    for (const item of list.items) {
      walkInline(item.children);
      item.lists.forEach(walkList);
    }
  };
  const walk = (nodes: readonly Block[]): void => {
    for (const block of nodes) {
      if (block.type === "heading" || block.type === "paragraph") walkInline(block.children);
      else if (block.type === "list") walkList(block.list);
      else if (block.type === "quote") walk(block.children);
      else if (block.type === "table") {
        block.header.forEach(walkInline);
        block.rows.forEach((row) => row.forEach(walkInline));
      }
    }
  };
  walk(blocks);
  return found;
}
