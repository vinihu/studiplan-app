import type { StudySet } from "@shared/study";
import { BackLink } from "../components/BackLink";
import { Notice } from "../components/Notice";
import { Page, PageHeader } from "../components/Page";
import { formatDate } from "../lib/format";
import { describeStudySet } from "./describe";
import { FlashcardPlayer } from "./FlashcardPlayer";
import { QuestionsPlayer } from "./QuestionsPlayer";
import { SummaryReader } from "./SummaryReader";

/**
 * The Study screen: one saved result, shown with the viewer for its kind.
 *
 * It fills the main area of the app frame, like the Material screen, and is given everything
 * it shows: it loads nothing and saves nothing. The way back is named after the material the
 * result belongs to.
 *
 * Give it a `key` that changes with the result (its file name), so opening another one starts
 * its viewer afresh.
 */
export function StudySetView({
  set,
  materialTitle,
  onBack,
  warnings = [],
}: {
  set: StudySet;
  /** The title of the material this result was made from. Names the way back. */
  materialTitle: string;
  onBack: () => void;
  /** What was adjusted while reading a file that was edited by hand. Usually empty. */
  warnings?: readonly string[];
}) {
  // A summary or a note is one reading column; everything above it keeps to the same width.
  const reading = set.kind === "summary" || set.kind === "explain" || set.kind === "custom";
  // A cheat sheet is wider than a reading column, and its notices keep to its width.
  const column = reading ? "max-w-[37rem]" : set.kind === "cheatsheet" ? "max-w-[48rem]" : "";

  return (
    <Page>
      <PageHeader
        above={<BackLink label={materialTitle} onPress={onBack} />}
        title={set.title}
        detail={describeStudySet(set, formatDate(set.created))}
      />

      <div className="flex flex-col gap-8">
        {set.kind === "custom" && set.content.request ? (
          <p dir="auto" className="-mt-4 max-w-[37rem] text-sm leading-relaxed whitespace-pre-line text-muted [overflow-wrap:anywhere]">
            <span className="font-medium text-foreground">You asked: </span>
            {set.content.request}
          </p>
        ) : null}

        {warnings.length > 0 ? (
          <Notice className={column} title="This file was changed outside Studiplan">
            <ul className="flex flex-col gap-1 text-sm text-muted">
              {warnings.map((warning, index) => (
                <li key={index} className="[overflow-wrap:anywhere]">
                  {warning}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {set.coverage === "cut" ? (
          <Notice className={column} title="Made from part of the material">
            The material was too long to send to the AI whole, so some of it was left out. Parts of it may not be covered here.
          </Notice>
        ) : null}

        <Viewer set={set} />
      </div>
    </Page>
  );
}

function Viewer({ set }: { set: StudySet }) {
  switch (set.kind) {
    case "summary":
    case "explain":
    case "custom":
      return <SummaryReader body={set.content.body} />;
    case "cheatsheet":
      return <SummaryReader body={set.content.body} dense />;
    case "flashcards":
      return <FlashcardPlayer cards={set.content.cards} />;
    case "test":
    case "quiz":
    case "exam":
      return <QuestionsPlayer questions={set.content.questions} kind={set.kind} />;
  }
}
