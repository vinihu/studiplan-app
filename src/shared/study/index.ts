/**
 * Results ("study sets"): what each kind looks like, how it is validated, how a model is told to
 * write one, and how it is named and stored. No I/O; shared by the main process and the renderer.
 *
 * ## The flow for the generation code (main process)
 *
 * ```ts
 * const request = buildGenerationRequest(kind, options);          // instructions + jsonSchema
 * if (!request.ok) …                                              // only "something else" with no text
 * let reply = await provider.generate({ instructions, parts, jsonSchema, signal });
 * let content = parseGenerationOutput(kind, reply, request.value.options);
 * if (!content.ok) {                                              // the one retry
 *   const again = buildRetryMessage({ kind, errors: content.errors, previousReply: reply });
 *   reply = await provider.generate({ instructions: `${instructions}\n\n${again}`, … });
 *   content = parseGenerationOutput(kind, reply, request.value.options);
 * }
 * if (!content.ok) …                                              // report; nothing is saved
 * const set = createStudySet({ kind, content: content.value, title, created: new Date(), … });
 * const name = studySetFileName(kind, new Date(), namesInSetsFolder);
 * write(name, serialiseStudySet(set));
 * ```
 *
 * Reading back: `listStudySetFiles(names)` for the Results list, `parseStudySetFile(name, text)`
 * to open one. A file is validated again when it is read — it may have been edited.
 *
 * ## For the viewers: everything here is untrusted text
 *
 * Validation bounds sizes and fixes shapes. It does **not** make a string safe to interpret:
 * `<script>`, `<img onerror=…>` and `javascript:` links pass through unchanged, on purpose, as
 * the characters they are. So:
 *
 *  - Render every card side, prompt, option, explanation, model answer and title as a **text
 *    node**. Never `dangerouslySetInnerHTML`, never a Markdown-to-HTML library that emits HTML.
 *    These strings are plain text, not Markdown; show line breaks with `white-space: pre-line`.
 *  - A summary or note body is Markdown written by a model, or edited by anyone. Render it with
 *    a renderer that builds elements from a parsed tree and puts all text into text nodes; raw
 *    HTML in the Markdown must come out as visible characters.
 *  - Links: only `http:`, `https:` and `mailto:` become links, and they open in the system
 *    browser through the main process's own check. Anything else renders as its label.
 *  - Do not turn Markdown images into `<img>`: a remote image is a request to someone's server
 *    the moment the summary opens. Show the alt text.
 *  - Strings can be long and unbroken (4,000-character prompts, a URL): wrap with
 *    `overflow-wrap: anywhere`.
 *  - Options may be shown in any order as long as `answerIndex` is followed through; the
 *    instructions forbid "all of the above" for that reason.
 */

export * from "./types";
export * from "./validate";
export * from "./json";
export * from "./schema";
export * from "./instructions";
export * from "./files";
