import { describe, expect, it } from "vitest";
import { collectInline, inlineText, parseInline, parseMarkdown, revealFor, safeHref, splitDocument, tidyLines } from "./markdown";
import { growthOf } from "@shared/test-scaling";
import type { Block, Inline } from "./markdown";

const text = (value: string): Inline => ({ type: "text", text: value });

/** The one block a source parses to. */
function only(source: string): Block {
  const blocks = parseMarkdown(source);
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

describe("safeHref: what may be a link", () => {
  it("allows http, https and mailto", () => {
    expect(safeHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    expect(safeHref("mailto:teacher@example.com")).toBe("mailto:teacher@example.com");
    expect(safeHref("  HTTPS://Example.com  ")).toBe("https://example.com/");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///C:/Windows/win.ini",
    "blob:https://example.com/1",
    "ftp://example.com/file",
    "studiplan://open",
    "//example.com/protocol-relative",
    "/absolute/path",
    "relative/path",
    "#anchor",
    "",
    "   ",
    "https://",
  ])("refuses %j", (address) => {
    expect(safeHref(address)).toBeNull();
  });

  it("refuses an address too long to be real", () => {
    expect(safeHref(`https://example.com/${"a".repeat(3_000)}`)).toBeNull();
  });
});

describe("inline", () => {
  it("leaves plain text alone", () => {
    expect(parseInline("Just words, 2 * 3 = 6 and a_b_c.")).toEqual([text("Just words, 2 * 3 = 6 and a_b_c.")]);
  });

  it("reads bold, italic, strikethrough and code", () => {
    expect(parseInline("**bold** *it* __b2__ _i2_ ~~gone~~ `x = 1`")).toEqual([
      { type: "strong", children: [text("bold")] },
      text(" "),
      { type: "em", children: [text("it")] },
      text(" "),
      { type: "strong", children: [text("b2")] },
      text(" "),
      { type: "em", children: [text("i2")] },
      text(" "),
      { type: "del", children: [text("gone")] },
      text(" "),
      { type: "code", text: "x = 1" },
    ]);
  });

  it("nests emphasis", () => {
    expect(parseInline("**bold with *italic* inside**")).toEqual([
      { type: "strong", children: [text("bold with "), { type: "em", children: [text("italic")] }, text(" inside")] },
    ]);
    expect(parseInline("***both***")).toEqual([{ type: "strong", children: [{ type: "em", children: [text("both")] }] }]);
  });

  it("does not read underscores inside a word as emphasis", () => {
    expect(inlineText(parseInline("snake_case_name and __init__ stay"))).toBe("snake_case_name and init stay");
    expect(parseInline("file_name_here")).toEqual([text("file_name_here")]);
  });

  it("keeps the inside of code as it is", () => {
    expect(parseInline("`**not bold** <b>`")).toEqual([{ type: "code", text: "**not bold** <b>" }]);
    expect(parseInline("``a ` b``")).toEqual([{ type: "code", text: "a ` b" }]);
  });

  it("drops the backslash of an escape", () => {
    expect(parseInline("\\*not italic\\* and 5 \\< 6")).toEqual([text("*not italic* and 5 < 6")]);
  });

  it("makes links of allowed addresses", () => {
    expect(parseInline("See [the **book**](https://example.com/a_(b)) now")).toEqual([
      text("See "),
      {
        type: "link",
        href: "https://example.com/a_(b)",
        children: [text("the "), { type: "strong", children: [text("book")] }],
      },
      text(" now"),
    ]);
    expect(parseInline('[t](https://example.com "A title")')).toEqual([
      { type: "link", href: "https://example.com/", children: [text("t")] },
    ]);
    expect(parseInline("<https://example.com/x>")).toEqual([
      { type: "link", href: "https://example.com/x", children: [text("https://example.com/x")] },
    ]);
  });

  it("turns a line break written as a tag into a break, not into markup", () => {
    expect(parseInline("one<br>two<BR />three")).toEqual([text("one"), { type: "break" }, text("two"), { type: "break" }, text("three")]);
  });
});

describe("hostile input stays text", () => {
  it("renders a javascript: link as its label only", () => {
    const nodes = parseInline("Click [here](javascript:alert(1)) please");
    expect(nodes).toEqual([text("Click here please")]);
    expect(JSON.stringify(nodes)).not.toContain("javascript");
  });

  it.each([
    "[x](JAVASCRIPT:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox(1))",
    "[x](file:///C:/Windows/win.ini)",
    "[x](/etc/passwd)",
    "[x](#top)",
    "<javascript:alert(1)>",
    "[x](java&#x73;cript:alert(1))",
  ])("makes no link of %s", (source) => {
    const links = collectInline(parseMarkdown(source)).filter((node) => node.type === "link");
    expect(links).toEqual([]);
  });

  it("keeps raw HTML as the characters that were written", () => {
    const source = '<script>alert("x")</script> and <img src=x onerror=alert(1)> and <iframe src="https://evil.example"></iframe>';
    expect(only(source)).toEqual({ type: "paragraph", children: [text(source)] });
  });

  it("keeps an HTML block as text, in every block type", () => {
    const blocks = parseMarkdown(
      [
        "# <script>alert(1)</script>",
        "",
        "- <img src=x onerror=alert(1)>",
        "",
        "> <a href=\"javascript:alert(1)\">x</a>",
        "",
        "| <b>h</b> |",
        "| --- |",
        "| <svg onload=alert(1)> |",
        "",
        "```html",
        "<script>alert(1)</script>",
        "```",
      ].join("\n"),
    );
    const types = new Set(collectInline(blocks).map((node) => node.type));
    expect([...types]).toEqual(["text"]);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "list", "quote", "table", "code"]);
    expect(blocks[4]).toEqual({ type: "code", text: "<script>alert(1)</script>", language: "html" });
  });

  it("never keeps the address of an image, only its alt text", () => {
    const blocks = parseMarkdown("Look: ![a cell dividing](https://tracker.example/pixel.png?id=1) and ![](https://tracker.example/2.png)");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [text("Look: "), { type: "image", alt: "a cell dividing" }, text(" and "), { type: "image", alt: "" }],
      },
    ]);
    expect(JSON.stringify(blocks)).not.toContain("tracker.example");
  });

  it("does not load an image hidden in a link either", () => {
    const blocks = parseMarkdown("[![alt](https://tracker.example/p.png)](https://example.com)");
    expect(JSON.stringify(blocks)).not.toContain("tracker.example");
    expect(collectInline(blocks).some((node) => node.type === "image")).toBe(true);
  });

  it("only ever produces the node types the renderer knows", () => {
    const hostile = [
      "<script>alert(1)</script>",
      "[a](javascript:alert(1)) ![i](http://x/y.png) <https://ok.example> <javascript:1>",
      "<div style=\"position:fixed\">cover</div>",
      "&lt;script&gt; &#60;script&#62;",
      "[ref]: javascript:alert(1)",
      "[a][ref]",
      "<!-- comment --><?php echo 1 ?><![CDATA[x]]>",
    ].join("\n\n");
    const allowed = new Set(["text", "strong", "em", "del", "code", "link", "image", "break"]);
    const nodes = collectInline(parseMarkdown(hostile));
    expect(nodes.every((node) => allowed.has(node.type))).toBe(true);
    const links = nodes.filter((node) => node.type === "link");
    expect(links.map((node) => (node.type === "link" ? node.href : ""))).toEqual(["https://ok.example/"]);
  });

  it("stays fast on long runs of unclosed markers", () => {
    // Timed at one length and at four times that: a pattern that tries the same stretch again
    // and again takes sixteen times as long, a bounded one about four.
    for (const piece of ["**a ", "_a ", "[a ", "`a ", "![a](", "[a](", "~~a ", "<", "\\", "> ", "- ", "| "]) {
      const growth = growthOf((size) => parseMarkdown(piece.repeat(Math.floor(size / piece.length))), 12_500);
      expect(growth.linear, `${JSON.stringify(piece)}: ${JSON.stringify(growth)}`).toBe(true);
    }
    const indented = growthOf((size) => parseMarkdown(Array.from({ length: size }, (_, i) => `${" ".repeat(i % 400)}- item`).join("\n")), 500);
    expect(indented.linear, JSON.stringify(indented)).toBe(true);
    const quotes = growthOf((size) => parseMarkdown(">".repeat(size)), 12_500);
    expect(quotes.linear, JSON.stringify(quotes)).toBe(true);
  }, 60_000);

  it("bounds how deep quotes and lists nest", () => {
    const depthOf = (blocks: Block[]): number =>
      Math.max(0, ...blocks.map((block) => (block.type === "quote" ? 1 + depthOf(block.children) : 0)));
    expect(depthOf(parseMarkdown(`${">".repeat(500)} deep`))).toBeLessThanOrEqual(4);

    const nested = Array.from({ length: 40 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
    const list = only(nested);
    let depth = 0;
    let current = list.type === "list" ? list.list : null;
    while (current) {
      depth++;
      current = current.items[current.items.length - 1]?.lists[0] ?? null;
    }
    expect(depth).toBeLessThanOrEqual(6);
  });
});

describe("blocks", () => {
  it("reads headings of every level, with a closing run of #", () => {
    expect(parseMarkdown("# One\n## Two ##\n###### Six")).toEqual([
      { type: "heading", level: 1, children: [text("One")] },
      { type: "heading", level: 2, children: [text("Two")] },
      { type: "heading", level: 6, children: [text("Six")] },
    ]);
    expect(only("#hashtag is text")).toEqual({ type: "paragraph", children: [text("#hashtag is text")] });
  });

  it("joins the lines of a paragraph and splits on a blank line", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", children: [text("one two")] },
      { type: "paragraph", children: [text("three")] },
    ]);
  });

  it("keeps a hard line break", () => {
    expect(only("one  \ntwo\\\nthree")).toEqual({
      type: "paragraph",
      children: [text("one"), { type: "break" }, text("two"), { type: "break" }, text("three")],
    });
  });

  it("keeps a year at the start of a wrapped line in its paragraph", () => {
    expect(only("It happened in\n2021. Then it stopped.")).toEqual({
      type: "paragraph",
      children: [text("It happened in 2021. Then it stopped.")],
    });
  });

  it("reads unordered and ordered lists", () => {
    expect(parseMarkdown("- a\n- b\n\n3. c\n4. d")).toEqual([
      {
        type: "list",
        list: {
          ordered: false,
          start: 1,
          items: [
            { children: [text("a")], lists: [] },
            { children: [text("b")], lists: [] },
          ],
        },
      },
      {
        type: "list",
        list: {
          ordered: true,
          start: 3,
          items: [
            { children: [text("c")], lists: [] },
            { children: [text("d")], lists: [] },
          ],
        },
      },
    ]);
  });

  it("nests lists by indentation, mixes kinds, and comes back out", () => {
    const block = only(["1. Interphase", "   - G1", "   - S", "     continued", "     1. deep", "2. Mitosis", "   1. Prophase"].join("\n"));
    expect(block).toEqual({
      type: "list",
      list: {
        ordered: true,
        start: 1,
        items: [
          {
            children: [text("Interphase")],
            lists: [
              {
                ordered: false,
                start: 1,
                items: [
                  { children: [text("G1")], lists: [] },
                  {
                    children: [text("S continued")],
                    lists: [{ ordered: true, start: 1, items: [{ children: [text("deep")], lists: [] }] }],
                  },
                ],
              },
            ],
          },
          {
            children: [text("Mitosis")],
            lists: [{ ordered: true, start: 1, items: [{ children: [text("Prophase")], lists: [] }] }],
          },
        ],
      },
    });
  });

  it("keeps a loose list as one list", () => {
    const block = only("- a\n\n- b\n\n- c");
    expect(block.type === "list" && block.list.items).toHaveLength(3);
  });

  it("reads a block quote, with blocks inside it", () => {
    expect(only("> **Note**\n> spans lines\n>\n> - point")).toEqual({
      type: "quote",
      children: [
        { type: "paragraph", children: [{ type: "strong", children: [text("Note")] }, text(" spans lines")] },
        { type: "list", list: { ordered: false, start: 1, items: [{ children: [text("point")], lists: [] }] } },
      ],
    });
  });

  it("reads fenced code literally, to the closing fence or the end", () => {
    expect(parseMarkdown("```js\nconst a = **1**;\n\n# not a heading\n```\nafter")).toEqual([
      { type: "code", text: "const a = **1**;\n\n# not a heading", language: "js" },
      { type: "paragraph", children: [text("after")] },
    ]);
    expect(only("~~~\nunclosed")).toEqual({ type: "code", text: "unclosed", language: null });
  });

  it("reads rules", () => {
    expect(parseMarkdown("a\n\n---\n\n***\n\n_ _ _").map((block) => block.type)).toEqual(["paragraph", "rule", "rule", "rule"]);
  });

  it("reads a table with alignment, short rows and an escaped pipe", () => {
    expect(only("| Phase | What | n |\n|:--|:-:|--:|\n| **Pro** | a \\| b | 1 |\n| Meta |")).toEqual({
      type: "table",
      align: ["left", "center", "right"],
      header: [[text("Phase")], [text("What")], [text("n")]],
      rows: [
        [[{ type: "strong", children: [text("Pro")] }], [text("a | b")], [text("1")]],
        [[text("Meta")], [], []],
      ],
    });
  });

  it("does not take a sentence with a pipe above a rule for a table", () => {
    expect(parseMarkdown("a | b\n---").map((block) => block.type)).toEqual(["paragraph", "rule"]);
  });

  it("accepts Windows line endings and any script", () => {
    expect(parseMarkdown("# Митоз\r\n\r\n細胞分裂は **重要** です。\r\n\r\n- الخلية")).toEqual([
      { type: "heading", level: 1, children: [text("Митоз")] },
      { type: "paragraph", children: [text("細胞分裂は "), { type: "strong", children: [text("重要")] }, text(" です。")] },
      { type: "list", list: { ordered: false, start: 1, items: [{ children: [text("الخلية")], lists: [] }] } },
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * A body is up to 2,000,000 characters written by anyone
 * ------------------------------------------------------------------ */

/** A summary as a model writes one: every kind of block, nothing unusual. */
const ORDINARY = [
  "# Cell division",
  "",
  "Mitosis makes **two identical cells**; meiosis makes *four* with half the chromosomes. See `S phase`.",
  "A second line of the same paragraph, with a [link](https://example.com/page) in it.",
  "",
  "## The phases",
  "",
  "1. Prophase",
  "2. Metaphase",
  "   - the chromosomes line up",
  "   - in the middle",
  "3. Anaphase",
  "",
  "> A quote, with ~~struck~~ words.",
  "",
  "| Phase | What happens |",
  "| :-- | --: |",
  "| Prophase | Chromosomes condense |",
  "| Telophase | Two nuclei form |",
  "",
  "```js",
  "const cells = 2;",
  "",
  "console.log(cells);",
  "```",
  "",
  "---",
  "",
  "The end.",
].join("\n");

describe("crafted input stays fast and small", () => {
  // Each of these took seconds, or all the memory there is, before its bound was added. Each is
  // built at a size and at four times that size, and the time may grow with the size, not with
  // its square (`growthOf`): a bound in milliseconds would only measure how busy the computer is.
  // The larger size is the one at which the unbounded pattern took seconds.
  const crafted: Array<[name: string, small: number, make: (size: number) => string]> = [
    ["a line of backticks, then text", 6_250, (n) => `${"`".repeat(n)}${"a".repeat(n)}`],
    ["a line of backticks, then text that is not Latin", 2_000, (n) => `${"`".repeat(n)}${"я".repeat(n)}`],
    ["backticks in pairs", 2_500, (n) => "`` a ".repeat(n)],
    ["a header of thousands of pipes over thousands of rows", 2_500, (n) => `${"|".repeat(n)}\n${"|-".repeat(n - 1)}|\n${"|\n".repeat(n)}`],
    ["a heading with a long run of blanks", 12_500, (n) => `# a${" ".repeat(n)}b`],
    ["a paragraph with a long run of blanks", 12_500, (n) => `a${" ".repeat(n)}b`],
    ["a paragraph with a long run of tabs", 12_500, (n) => `a${"\t".repeat(n)}b`],
    ["a table divider with a long run of blanks", 12_500, (n) => `a|b\n|-${" ".repeat(n)}x`],
    ["a link address of blanks", 12_500, (n) => `[a](${" ".repeat(n)}x`],
    ["a link address of no-break spaces", 12_500, (n) => `[a](${"\u00a0".repeat(n)}x`],
    ["a link title after blanks", 12_500, (n) => `[a](b${"\u2003".repeat(n)}"t`],
    ["many runs of blanks just under the limit", 60, (n) => `# ${`a${" ".repeat(199)}`.repeat(n)}`],
  ];

  it.each(crafted)("%s", (_name, small, make) => {
    const growth = growthOf((size) => parseMarkdown(make(size)), small);
    expect(growth.linear, JSON.stringify(growth)).toBe(true);
  }, 60_000);

  it("the first part of two million characters is all that opening a document reads", () => {
    // What the viewer does: split the whole document, then parse its first part only. Splitting
    // grows with the document; the first part does not grow at all.
    const shapes: Array<(size: number) => string> = [];
    for (const piece of ["__a ", "*a* ", "[a](", "`a ", "| ", "- "]) {
      shapes.push((size) => piece.repeat(Math.floor(size / piece.length)));
      shapes.push((size) => `${piece.repeat(20)}\n`.repeat(Math.floor(size / (piece.length * 20 + 1))));
    }
    shapes.push((size) => "word ".repeat(size / 5));
    shapes.push((size) => "x".repeat(size));
    for (const [index, make] of shapes.entries()) {
      const growth = growthOf((size) => parseMarkdown(splitDocument(make(size))[0] ?? ""), 500_000);
      expect(growth.linear, `shape ${index}: ${JSON.stringify(growth)}`).toBe(true);
      expect((splitDocument(make(2_000_000))[0] ?? "").length).toBeLessThanOrEqual(70_100);
    }
  }, 120_000);

  it("a table is at most 30 columns wide and 500 rows long; the rest stays text", () => {
    const wide = only(`${"|a".repeat(31)}|\n${"|-".repeat(31)}|\n${"|x".repeat(31)}|`);
    expect(wide.type).toBe("paragraph");

    const blocks = parseMarkdown(`|a|b|\n|-|-|\n${"|1|2|\n".repeat(700)}`);
    const table = blocks[0];
    expect(table?.type === "table" ? table.rows.length : 0).toBe(500);
    expect(inlineText(collectInline(blocks.slice(1)).filter((node) => node.type === "text"))).toContain("|1|2|");

    const cells = (list: Block[]): number =>
      list.reduce((sum, block) => sum + (block.type === "table" ? block.rows.length * block.header.length : 0), 0);
    expect(cells(parseMarkdown(`${"|".repeat(10_000)}\n${"|-".repeat(9_999)}|\n${"|\n".repeat(10_000)}`))).toBe(0);
  });

  it("code spans still read as they did", () => {
    expect(parseInline("a `code` b")).toEqual([text("a "), { type: "code", text: "code" }, text(" b")]);
    expect(parseInline("``a ` b``")).toEqual([{ type: "code", text: "a ` b" }]);
    expect(parseInline("`` `a` ``")).toEqual([{ type: "code", text: "`a`" }]);
    expect(parseInline("`open")).toEqual([text("`open")]);
  });
});

describe("tidyLines and splitDocument", () => {
  it("leave an ordinary document as it is: the same lines, one part, the same tree", () => {
    expect(tidyLines(ORDINARY)).toEqual(ORDINARY.split("\n"));
    expect(splitDocument(ORDINARY)).toEqual([ORDINARY]);
    expect(parseMarkdown(splitDocument(ORDINARY)[0] ?? "")).toEqual(parseMarkdown(ORDINARY));
  });

  it("the tree of an ordinary document is what it always was", () => {
    const blocks = parseMarkdown(ORDINARY);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "heading", "list", "quote", "table", "code", "rule", "paragraph"]);
    expect(blocks[1]).toEqual({
      type: "paragraph",
      children: [
        text("Mitosis makes "),
        { type: "strong", children: [text("two identical cells")] },
        text("; meiosis makes "),
        { type: "em", children: [text("four")] },
        text(" with half the chromosomes. See "),
        { type: "code", text: "S phase" },
        text(". A second line of the same paragraph, with a "),
        { type: "link", href: "https://example.com/page", children: [text("link")] },
        text(" in it."),
      ],
    });
    const table = blocks[5];
    expect(table?.type === "table" ? [table.align, table.rows.length] : null).toEqual([["left", "right"], 2]);
    expect(blocks[6]).toEqual({ type: "code", text: "const cells = 2;\n\nconsole.log(cells);", language: "js" });
  });

  it("a long document comes in parts that end at blank lines, and reads the same in parts as whole", () => {
    const long = Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nSome words about **section ${i}**.\n\n- one\n- two`).join("\n\n");
    const parts = splitDocument(long, 2_000);
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) expect(part.length).toBeLessThan(2_200);
    expect(parts.flatMap((part) => parseMarkdown(part))).toEqual(parseMarkdown(long));
  });

  it("never cuts inside a code block while a blank line outside it is near", () => {
    const code = `\`\`\`\n${"line\n\n".repeat(200)}\`\`\``;
    const parts = splitDocument(`before\n\n${code}\n\nafter`, 1_000);
    expect(parts.map((part) => parseMarkdown(part).map((block) => block.type))).toEqual([["paragraph", "code"], ["paragraph"]]);
  });

  it("closes and opens an endless code block around a cut, so the rest is still code", () => {
    const parts = splitDocument(`\`\`\`\n${"x = 1\n".repeat(5_000)}`, 5_000);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThan(10_100);
      expect(parseMarkdown(part).map((block) => block.type)).toEqual(["code"]);
    }
  });

  it("breaks an endless line at a blank and keeps it in its paragraph or list item", () => {
    const words = "word ".repeat(5_000).trim();
    expect(tidyLines(words).every((line) => line.length <= 10_000)).toBe(true);
    expect(parseMarkdown(words)).toEqual([{ type: "paragraph", children: [text(words)] }]);
    const item = parseMarkdown(`- ${words}\n- next`)[0];
    expect(item?.type === "list" ? item.list.items.map((entry) => inlineText(entry.children).length) : null).toEqual([words.length, 4]);
  });

  it("makes one blank of a run of 200 or more, and leaves shorter runs alone", () => {
    expect(tidyLines(`a${" ".repeat(500)}b`)).toEqual(["a b"]);
    expect(tidyLines(`a${" ".repeat(150)}b`)).toEqual([`a${" ".repeat(150)}b`]);
  });
});

describe("links that are not what they say", () => {
  it("refuses an address with a user name or a password in front of the host", () => {
    for (const address of ["https://trusted.example@evil.example/", "https://user:pw@evil.example/", "http://bank.example:secret@evil.example/login"]) {
      expect(safeHref(address), address).toBeNull();
    }
    // Its label is kept as text; there is no link to press.
    expect(parseInline("[the bank](https://bank.example@evil.example/)")).toEqual([text("the bank")]);
  });

  it("takes a mail link only as one plain address, as the main process does", () => {
    expect(safeHref("mailto:teacher@example.com")).toBe("mailto:teacher@example.com");
    for (const address of [
      "mailto:teacher@example.com?subject=Hello",
      "mailto:teacher@example.com?body=Send%20me%20your%20password",
      "mailto:a@example.com,b@example.com",
      "mailto:a@example.com?cc=b@example.com",
      "mailto:",
      "mailto:%0Aa@example.com",
    ]) {
      expect(safeHref(address), address).toBeNull();
    }
  });

  it("takes direction-changing characters out of a link's label", () => {
    const [link] = parseInline("[‮moc.elpmaxe‬⁦!⁩‏](https://evil.example/)");
    expect(link?.type === "link" ? inlineText(link.children) : null).toBe("moc.elpmaxe!");
  });

  it("says where a link goes when its label names another address", () => {
    const reveal = (source: string) => {
      const [link] = parseInline(source);
      return link?.type === "link" ? link.reveal : "not a link";
    };
    expect(reveal("[https://bank.example/login](https://evil.example/login)")).toBe("evil.example");
    expect(reveal("[bank.example](https://evil.example/)")).toBe("evil.example");
    expect(reveal("[Sign in at www.bank.example today](https://evil.example/)")).toBe("evil.example");
    expect(reveal("[bank.example](https://bank.example.evil.example/)")).toBe("bank.example.evil.example");
    expect(reveal("[teacher@school.example](https://evil.example/)")).toBe("evil.example");
    expect(reveal("[teacher@school.example](mailto:someone@evil.example)")).toBe("someone@evil.example");
    // Look-alike letters: the host is shown in the form that cannot be dressed up.
    expect(reveal("[the course page](https://xn--pple-43d.com/)")).toBe("xn--pple-43d.com");
  });

  it("says nothing more when the label is words, or names the place the link goes", () => {
    const reveal = (source: string) => {
      const [link] = parseInline(source);
      return link?.type === "link" ? "reveal" in link : "not a link";
    };
    expect(reveal("[the course page](https://example.com/course)")).toBe(false);
    expect(reveal("[example.com](https://example.com/course)")).toBe(false);
    expect(reveal("[www.example.com](https://example.com/)")).toBe(false);
    expect(reveal("[https://Example.com/a](https://www.example.com/a)")).toBe(false);
    expect(reveal("[example.com](https://docs.example.com/)")).toBe(false);
    expect(reveal("[teacher@example.com](mailto:teacher@example.com)")).toBe(false);
    expect(reveal("[Section 2.1, e.g. the first](https://example.com/)")).toBe(false);
    expect(reveal("<https://example.com/x>")).toBe(false);
    expect(revealFor("not an address", "bank.example")).toBeUndefined();
  });
});
