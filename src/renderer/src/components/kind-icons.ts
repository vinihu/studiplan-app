import { AlignLeft, ClipboardList, GraduationCap, Layers, Lightbulb, ListChecks, PenLine, TableProperties } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { StudySetKind } from "@shared/study";

/** One icon per kind of result, the same on its Make button and on its row in Results. */
export const KIND_ICONS: Readonly<Record<StudySetKind, LucideIcon>> = {
  summary: AlignLeft,
  explain: Lightbulb,
  cheatsheet: TableProperties,
  flashcards: Layers,
  test: GraduationCap,
  quiz: ListChecks,
  exam: ClipboardList,
  custom: PenLine,
};
