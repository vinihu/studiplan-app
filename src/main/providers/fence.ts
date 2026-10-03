/**
 * A model's answer without the code fence some models put around JSON:
 *
 *     ```json
 *     { … }
 *     ```
 *
 * Shared by every provider. Written as plain string work on purpose: the regular expression
 * this replaces took time quadratic in the answer's length on an answer that opens a fence and
 * goes on with blank lines, and an answer can be megabytes.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 7 || !trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  // The opening line is the three backticks, a language name at most, and blanks.
  if (firstBreak === -1 || firstBreak > trimmed.length - 3) return trimmed;
  const info = trimmed.slice(3, firstBreak);
  if (info.length > 40 || !/^[A-Za-z]*[ \t\r]*$/.test(info)) return trimmed;
  return trimmed.slice(firstBreak + 1, trimmed.length - 3).trim();
}
