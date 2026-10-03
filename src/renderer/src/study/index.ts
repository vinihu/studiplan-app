/**
 * Study: the viewers for a saved result.
 *
 * `StudySetView` is the screen. It takes a `StudySet`, the title of its material and a way
 * back, and picks the viewer for the kind: `SummaryReader` (summary, note), `FlashcardPlayer`
 * (flashcards) or `QuestionsPlayer` (quiz, mock exam). The viewers are exported too, for a
 * place that wants one without the screen around it.
 *
 * Everything shown is untrusted text and is drawn as text: see `markdown.ts`.
 */
export { StudySetView } from "./StudySetView";
export { SummaryReader } from "./SummaryReader";
export { FlashcardPlayer } from "./FlashcardPlayer";
export { QuestionsPlayer } from "./QuestionsPlayer";
export { MarkdownView } from "./MarkdownView";
