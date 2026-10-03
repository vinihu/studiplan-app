import { extractPdfText } from "./pdf";
import { extractPptxText } from "./pptx";
import type { ExtractInput, ExtractOptions, ExtractResult, TextFileKind } from "./types";

/** The text of a PDF or a deck, by kind. Never throws. Photo sets have no text and never come here. */
export function extractText(
  kind: TextFileKind,
  input: ExtractInput,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  switch (kind) {
    case "pdf":
      return extractPdfText(input, options);
    case "pptx":
      return extractPptxText(input, options);
    default:
      return Promise.resolve({
        ok: false,
        error: { code: "corrupt", message: "Studiplan cannot read text from this kind of file. Add a PDF, a PowerPoint (.pptx) or photos instead." },
      });
  }
}
