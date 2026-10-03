import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reads the colours straight out of theme.css and checks them against WCAG AA, so a change
 * to the theme that makes text hard to read fails the test run.
 */

const css = readFileSync(join(import.meta.dirname, "theme.css"), "utf8");

/** The value of a custom property in theme.css, following `var(--other)` references. */
function token(name: string): string {
  const match = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m").exec(css);
  if (!match?.[1]) throw new Error(`--${name} is not defined in theme.css`);
  const value = match[1].trim();
  const reference = /^var\(--([a-z-]+)\)$/.exec(value);
  return reference?.[1] ? token(reference[1]) : value;
}

/** Relative luminance of a `#rrggbb` colour (WCAG 2.x). */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Expected a #rrggbb colour, got "${hex}"`);
  const [r, g, b] = match.slice(1).map((part) => {
    const channel = parseInt(part, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA = 4.5;

describe("the window's own colours", () => {
  // The main process paints the window before the page does, and the title bar's buttons over
  // it. It cannot read CSS, so it has the two colours as constants; they must be the theme's.
  const source = readFileSync(join(import.meta.dirname, "../../../main/window.ts"), "utf8");
  const constant = (name: string) => new RegExp(`export const ${name} = "(#[0-9a-f]{6})";`).exec(source)?.[1];

  it("are the theme's surface and text colours", () => {
    expect(constant("WINDOW_SURFACE")).toBe(token("background"));
    expect(constant("WINDOW_SYMBOLS")).toBe(token("foreground"));
  });
});

describe("theme contrast (WCAG AA)", () => {
  const pairs: Array<[text: string, surface: string]> = [
    ["foreground", "background"],
    ["accent", "background"],
    ["accent-foreground", "accent"],
    ["muted", "background"],
    ["muted", "surface-secondary"],
    ["foreground", "default"],
    ["danger-foreground", "danger"],
    ["danger", "background"],
    ["success-foreground", "success"],
    ["success", "background"],
  ];

  for (const [text, surface] of pairs) {
    it(`--${text} on --${surface} is at least ${AA}:1`, () => {
      expect(contrast(token(text), token(surface))).toBeGreaterThanOrEqual(AA);
    });
  }

  it("matches the ratios documented in theme.css", () => {
    expect(contrast(token("accent"), token("background")).toFixed(2)).toBe("6.70");
    expect(contrast(token("accent-foreground"), token("accent")).toFixed(2)).toBe("6.70");
    expect(contrast(token("foreground"), token("background")).toFixed(2)).toBe("18.88");
    expect(contrast(token("muted"), token("background")).toFixed(2)).toBe("6.69");
    expect(contrast(token("danger-foreground"), token("danger")).toFixed(2)).toBe("5.74");
    expect(contrast(token("success-foreground"), token("success")).toFixed(2)).toBe("5.02");
  });
});
