/**
 * Changing a saved result's title by editing its file's text in place.
 *
 * Only the title changes. The file is not read into a `StudySet` and written out again: a
 * student may have edited it, and a rename must not tidy, shorten or drop anything of theirs.
 *
 * Pure: strings in, a string out.
 */
import { parseStudySetFileName, splitFrontMatter } from "@shared/study";

/** Thrown when the file is not something a title can be put into. */
export class NotRetitleable extends Error {}

const FRONT_MATTER_SEARCH = 40;

/**
 * `text` with its title replaced by `title` (one clean line). `fileName` decides the format.
 * Throws `NotRetitleable` for a JSON file that is not a JSON object.
 */
export function retitleStudySetText(fileName: string, text: string, title: string): string {
  const info = parseStudySetFileName(fileName);
  if (info === null) throw new NotRetitleable();

  if (info.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      throw new NotRetitleable();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new NotRetitleable();
    return `${JSON.stringify({ ...parsed, title }, null, 2)}\n`;
  }

  const bom = text.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
  const body = bom === "" ? text : text.slice(1);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  // Always JSON-quoted: the reader takes that for any title, and no title can then break the line.
  const titleLine = `title: ${JSON.stringify(title)}`;

  // The same test the reader applies: a leading `---` block that holds a key the app writes.
  if (splitFrontMatter(text).fields.size > 0) {
    let end = -1;
    for (let index = 1; index < lines.length && index <= FRONT_MATTER_SEARCH; index += 1) {
      if ((lines[index] ?? "").trimEnd() === "---") {
        end = index;
        break;
      }
    }
    if (end !== -1) {
      const at = lines.findIndex((line, index) => index > 0 && index < end && /^title:/i.test(line));
      if (at === -1) lines.splice(1, 0, titleLine);
      else lines[at] = titleLine;
      return bom + lines.join(eol);
    }
  }

  // The student removed the front matter: put back the little that is needed to carry a title.
  return bom + ["---", titleLine, `kind: ${info.kind}`, "---", "", ...lines].join(eol);
}
