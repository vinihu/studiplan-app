/**
 * Text extraction: PDF and .pptx text read locally, and the bounded content of a whole
 * material for one AI request. See `limits.ts` for every cap.
 */

export { extractText } from "./extract";
export { countPdfPages, extractPdfText } from "./pdf";
export { extractPptxText } from "./pptx";
export { buildPromptContent, shareBudget } from "./content";
export { renderSection, renderSections } from "./shared";
export * from "./limits";
export type {
  ContentNotice,
  MaterialFileInput,
  PromptContent,
  PromptContentOptions,
  PromptImagesPart,
  PromptPart,
  PromptTextPart,
} from "./content";
export type {
  ExtractError,
  ExtractErrorCode,
  ExtractInput,
  ExtractOptions,
  ExtractResult,
  ExtractedDocument,
  ExtractedSection,
  TextFileKind,
} from "./types";
