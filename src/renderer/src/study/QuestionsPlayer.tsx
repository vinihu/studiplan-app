import { Button, Chip, Label, Radio, RadioGroup, TextArea, TextField, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Check, RotateCcw, X } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { STUDY_SET_KIND_LABELS } from "@shared/study";
import type { MultipleChoiceQuestion, Question, WrittenQuestion } from "@shared/study";
import { plural } from "./describe";
import { emptyAnswers, emptySelfMarks, isAnswered, scoreAttempt, shuffleOptions, unanswered } from "./scoring";
import type { Answer, QuestionResult, QuestionStatus, Score, SelfMark } from "./scoring";

/**
 * A practice test (and the quiz and mock exam of earlier versions): one shape, so one viewer.
 *
 * ## The flow: one page, one Submit
 *
 * Every question is on one scrolling page, like a worksheet, with Submit in a bar that stays at
 * the bottom of the window. A student can see how much there is, answer in any order, skip a
 * hard one and come back, which is how a paper is worked, and a quiz of ten is done without
 * ten presses of "Next". After submitting, the same page is the review: each question is marked
 * where it was answered, with the right option, the explanation and, for a written answer, the
 * model answer and the student's own mark. Nothing moves, so "what did I put for 7?" is a
 * scroll, not a hunt.
 *
 * A question may be left unanswered. The first press of Submit then says how many are missing
 * and offers a jump to each; the second submits anyway, and they earn nothing.
 *
 * Marking and the score are in `scoring.ts`. Right and wrong are said with an icon and a word,
 * never by colour alone. Nothing is saved: answers live in this component and are gone on
 * leaving the screen.
 *
 * The options of a multiple-choice question are shown in a new order on every attempt (see
 * `shuffleOptions`): a model tends to write the right answer first.
 *
 * Prompts, options, explanations and model answers are plain text, not Markdown.
 */
export function QuestionsPlayer({ questions: saved, kind }: { questions: readonly Question[]; kind: "test" | "quiz" | "exam" }) {
  const uid = useId();
  /** One per attempt: the order of the options holds while answering and in the review. */
  const [seed, setSeed] = useState(newSeed);
  const questions = useMemo(() => shuffleOptions(saved, seed), [saved, seed]);
  const [phase, setPhase] = useState<"answering" | "review">("answering");
  const [answers, setAnswers] = useState<Answer[]>(() => emptyAnswers(questions));
  const [selfMarks, setSelfMarks] = useState<SelfMark[]>(() => emptySelfMarks(questions));
  /** Submit was pressed with questions unanswered, and they have been pointed out. */
  const [warned, setWarned] = useState(false);

  const top = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);

  const missing = useMemo(() => unanswered(questions, answers), [questions, answers]);
  const score = useMemo(() => scoreAttempt(questions, answers, selfMarks), [questions, answers, selfMarks]);
  const hasWritten = useMemo(() => questions.some((question) => question.type === "written"), [questions]);

  const setAnswer = useCallback((index: number, value: Answer) => {
    setAnswers((current) => current.map((answer, i) => (i === index ? value : answer)));
  }, []);
  const setSelfMark = useCallback((index: number, value: SelfMark) => {
    setSelfMarks((current) => current.map((mark, i) => (i === index ? value : mark)));
  }, []);

  // Submitting and retaking both replace the page: go to its top and put focus there.
  const lastPhase = useRef(phase);
  useEffect(() => {
    if (lastPhase.current === phase) return;
    lastPhase.current = phase;
    // "end" brings the page back to its very top, title included, since this block sits near it.
    top.current?.scrollIntoView({ block: "end" });
    top.current?.focus({ preventScroll: true });
  }, [phase]);

  function submit() {
    if (missing.length > 0 && !warned) {
      setWarned(true);
      return;
    }
    setPhase("review");
  }

  function retake() {
    setSeed(newSeed());
    setAnswers(emptyAnswers(questions));
    setSelfMarks(emptySelfMarks(questions));
    setWarned(false);
    setPhase("answering");
  }

  function goToQuestion(index: number) {
    const item = list.current?.children[index];
    if (!(item instanceof HTMLElement)) return;
    item.scrollIntoView({ block: "center" });
    item.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
  }

  const reviewing = phase === "review";

  return (
    <section aria-label={STUDY_SET_KIND_LABELS[kind]} className="flex flex-col">
      <div ref={top} tabIndex={-1} className="outline-none">
        {reviewing ? (
          <ScoreSummary score={score} onRetake={retake} />
        ) : hasWritten ? (
          <p className="max-w-[65ch] text-sm leading-relaxed text-muted">
            Written answers are marked by you: after you submit, you compare yours with a model answer.
          </p>
        ) : null}
      </div>

      <ol
        ref={list}
        className={`flex list-none flex-col ${reviewing || hasWritten ? "mt-8 border-t border-separator" : ""}`}
      >
        {questions.map((question, index) => (
          <QuestionItem
            key={index}
            id={`${uid}-q${index}`}
            index={index}
            question={question}
            answer={answers[index] ?? null}
            result={reviewing ? (score.questions[index] ?? null) : null}
            selfMark={selfMarks[index] ?? null}
            first={index === 0 && !reviewing && !hasWritten}
            onAnswer={setAnswer}
            onSelfMark={setSelfMark}
          />
        ))}
      </ol>

      {reviewing ? (
        <div className="mt-8 flex">
          <Button variant="outline" onPress={retake}>
            <RotateCcw aria-hidden />
            Retake
          </Button>
        </div>
      ) : (
        <div className="sticky bottom-0 z-10 -mx-1 flex min-h-[4.5rem] px-1 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border bg-background py-4">
          {warned && missing.length > 0 ? (
            <MissingNotice missing={missing} onGo={goToQuestion} />
          ) : (
            <p className="text-sm text-muted tabular-nums">
              {questions.length - missing.length} of {questions.length} answered
            </p>
          )}
          <Button variant="primary" className="ms-auto" onPress={submit}>
            {warned && missing.length > 0 ? "Submit anyway" : "Submit"}
          </Button>
        </div>
      )}
    </section>
  );
}

/** How many numbers of unanswered questions are offered as jumps before "and N more". */
const MAX_JUMPS = 5;

function MissingNotice({ missing, onGo }: { missing: readonly number[]; onGo: (index: number) => void }) {
  const shown = missing.slice(0, MAX_JUMPS);
  const more = missing.length - shown.length;
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <p>
        <span className="font-medium">
          {missing.length === 1 ? "1 question is" : `${missing.length} questions are`} not answered
        </span>
        <span className="text-muted"> and will earn no points.</span>
      </p>
      <p className="flex flex-wrap items-center gap-1 text-muted">
        Go to
        {shown.map((index) => (
          <Button
            key={index}
            size="sm"
            variant="ghost"
            className="min-w-8 px-2 text-accent tabular-nums"
            aria-label={`Go to question ${index + 1}`}
            onPress={() => onGo(index)}
          >
            {index + 1}
          </Button>
        ))}
        {more > 0 ? <span>and {more} more</span> : null}
      </p>
    </div>
  );
}

function newSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

function ScoreSummary({ score, onRetake }: { score: Score; onRetake: () => void }) {
  const right = score.questions.filter((result) => result.status === "correct").length;
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div role="status">
        <h2 className="text-sm font-medium text-muted">{score.final ? "Your score" : "Your score so far"}</h2>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-3 tabular-nums">
          <span className="text-3xl leading-10 font-semibold tracking-tight">
            {score.earned} / {score.possible}
          </span>
          <span className="text-base text-muted">
            {score.possible === 1 ? "point" : "points"}
            {score.percent !== null ? ` · ${score.percent}%` : null}
          </span>
        </p>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {score.final
            ? `${right} of ${plural(score.questions.length, "question")} fully right.`
            : `${plural(score.toMark, "written answer")} to mark below, worth up to ${plural(score.toMarkPoints, "point")}.`}
        </p>
      </div>
      <Button variant="outline" onPress={onRetake}>
        <RotateCcw aria-hidden />
        Retake
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One question
 * ------------------------------------------------------------------ */

/** Model-written text of any length, in any script: line breaks kept, long words wrapped. */
const PLAIN = "whitespace-pre-line [overflow-wrap:anywhere]";

interface QuestionItemProps {
  id: string;
  index: number;
  question: Question;
  answer: Answer;
  /** The marked result once submitted; `null` while answering. */
  result: QuestionResult | null;
  selfMark: SelfMark;
  first: boolean;
  onAnswer: (index: number, value: Answer) => void;
  onSelfMark: (index: number, value: SelfMark) => void;
}

const QuestionItem = memo(function QuestionItem({
  id,
  index,
  question,
  answer,
  result,
  selfMark,
  first,
  onAnswer,
  onSelfMark,
}: QuestionItemProps) {
  const promptId = `${id}-prompt`;
  return (
    <li className={`flex flex-col gap-4 border-b border-separator pb-9 ${first ? "" : "pt-8"}`}>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="text-xs font-medium text-muted tabular-nums">
            Question {index + 1} · {plural(question.points, "point")}
          </p>
          {result ? <StatusChip result={result} /> : null}
        </div>
        <h3 id={promptId} dir="auto" className={`max-w-[70ch] text-base leading-7 font-semibold ${PLAIN}`}>
          {question.prompt}
        </h3>
      </div>

      {question.type === "multiple_choice" ? (
        result ? (
          <OptionsReview question={question} answer={answer} labelledBy={promptId} />
        ) : (
          <RadioGroup
            aria-labelledby={promptId}
            className="-mx-3 gap-0.5"
            value={typeof answer === "number" ? String(answer) : null}
            onChange={(value) => onAnswer(index, Number(value))}
          >
            {question.options.map((option, i) => (
              <Radio key={i} value={String(i)} className="mt-0! w-full">
                {/* The whole line is the option. It answers the pointer like a row of a list, and reaches
                    into the hair of space between two options so that no strip between them is dead. */}
                <Radio.Content className="w-full items-start gap-3 rounded-md px-3 py-1.5 text-[0.9375rem] leading-6 font-normal transition-colors duration-100 ease-out before:absolute before:inset-x-0 before:-inset-y-px before:content-[''] data-[hovered=true]:bg-default/50 motion-reduce:transition-none">
                  {/* Round, whatever the theme's radius: a square one reads as a checkbox. */}
                  <Radio.Control className="mt-1">
                    <Radio.Indicator />
                  </Radio.Control>
                  {/* <bdi>: right-to-left text reads right, and still starts next to its radio. */}
                  <Label className={`relative min-w-0 flex-1 text-[0.9375rem] leading-6 font-normal ${PLAIN}`}>
                    <bdi>{option}</bdi>
                  </Label>
                </Radio.Content>
              </Radio>
            ))}
          </RadioGroup>
        )
      ) : result ? (
        <WrittenReview
          question={question}
          answer={answer}
          result={result}
          selfMark={selfMark}
          onSelfMark={(value) => onSelfMark(index, value)}
        />
      ) : (
        <TextField
          fullWidth
          aria-labelledby={promptId}
          value={typeof answer === "string" ? answer : ""}
          onChange={(value) => onAnswer(index, value)}
        >
          <TextArea
            fullWidth
            rows={5}
            dir="auto"
            placeholder="Your answer"
            className="max-w-[70ch] resize-y text-[0.9375rem] leading-6"
          />
        </TextField>
      )}

      {result && question.explanation ? (
        <Note label={question.type === "written" ? "Marking notes" : "Why"}>{question.explanation}</Note>
      ) : null}
    </li>
  );
});

const STATUS: Record<QuestionStatus, { label: string; color: "success" | "danger" | "default"; icon: "check" | "x" | null }> = {
  correct: { label: "Correct", color: "success", icon: "check" },
  wrong: { label: "Wrong", color: "danger", icon: "x" },
  partial: { label: "Partly right", color: "default", icon: null },
  unanswered: { label: "Not answered", color: "default", icon: null },
  "to-mark": { label: "To mark", color: "default", icon: null },
};

function StatusChip({ result }: { result: QuestionResult }) {
  const status = STATUS[result.status];
  return (
    <Chip size="sm" variant="soft" color={status.color} className="gap-1 px-2 tabular-nums">
      {status.icon === "check" ? <Check aria-hidden className="size-3.5" /> : null}
      {status.icon === "x" ? <X aria-hidden className="size-3.5" /> : null}
      <Chip.Label>
        {status.label}
        {result.status === "to-mark" ? null : ` · ${result.earned} / ${result.possible}`}
      </Chip.Label>
    </Chip>
  );
}

/** The options after submitting: the right one in green, a wrong pick in red, each with its word. */
function OptionsReview({
  question,
  answer,
  labelledBy,
}: {
  question: MultipleChoiceQuestion;
  answer: Answer;
  labelledBy: string;
}) {
  return (
    <ul aria-labelledby={labelledBy} className="-mx-3 flex list-none flex-col gap-0.5">
      {question.options.map((option, i) => {
        const correct = i === question.answerIndex;
        const picked = answer === i;
        const note = correct ? (picked ? "Your answer, correct" : "Correct answer") : picked ? "Your answer" : null;
        const tone = correct ? "text-success" : picked ? "text-danger" : "text-muted";
        return (
          <li
            key={i}
            className={`flex items-start gap-3 rounded-md px-3 py-1.5 text-[0.9375rem] leading-6 ${
              correct ? "bg-success-soft" : picked ? "bg-danger-soft" : ""
            }`}
          >
            <span aria-hidden className={`mt-1 flex size-4 shrink-0 items-center justify-center ${tone}`}>
              {correct ? (
                <Check className="size-4" strokeWidth={2.5} />
              ) : picked ? (
                <X className="size-4" strokeWidth={2.5} />
              ) : (
                <span className="size-1 rounded-full bg-current" />
              )}
            </span>
            <span className={`min-w-0 flex-1 ${PLAIN} ${correct ? "font-medium" : picked ? "" : "text-muted"}`}>
              <bdi>{option}</bdi>
            </span>
            {note ? (
              <span
                className={`shrink-0 text-xs leading-6 font-medium ${
                  correct ? "text-success-soft-foreground" : "text-danger-soft-foreground"
                }`}
              >
                {note}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function WrittenReview({
  question,
  answer,
  result,
  selfMark,
  onSelfMark,
}: {
  question: WrittenQuestion;
  answer: Answer;
  result: QuestionResult;
  selfMark: SelfMark;
  onSelfMark: (value: SelfMark) => void;
}) {
  const answered = isAnswered(question, answer);
  return (
    <div className="flex flex-col gap-4">
      <Note label="Your answer">
        {answered ? String(answer).trim() : <span className="text-muted">You did not write an answer.</span>}
      </Note>
      <Note label="Model answer">{question.modelAnswer}</Note>
      {answered ? (
        <SelfMarkControl points={result.possible} value={selfMark} onChange={onSelfMark} />
      ) : null}
    </div>
  );
}

/** A labelled piece of plain text under a question. */
function Note({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="max-w-[70ch]">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div dir="auto" className={`mt-1 text-[0.9375rem] leading-6 ${PLAIN}`}>
        {children}
      </div>
    </div>
  );
}

/**
 * The student's own mark for a written answer. One point is a yes or no; more points are a row
 * of numbers from 0 to what the question is worth, because a six-point answer is rarely all or
 * nothing.
 */
function SelfMarkControl({
  points,
  value,
  onChange,
}: {
  points: number;
  value: SelfMark;
  onChange: (value: SelfMark) => void;
}) {
  const labelId = useId();
  const choices =
    points === 1
      ? [
          { mark: 0, label: "Missed it" },
          { mark: 1, label: "Got it" },
        ]
      : Array.from({ length: points + 1 }, (_, mark) => ({ mark, label: String(mark) }));
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-4 py-3">
      <p id={labelId} className="text-sm font-medium">
        {points === 1 ? "Compare the two. Did you get it?" : `Compare the two. How many of the ${points} points did you earn?`}
      </p>
      <ToggleButtonGroup
        aria-labelledby={labelId}
        isDetached
        size="sm"
        selectionMode="single"
        className="flex-wrap justify-start gap-1.5"
        selectedKeys={value === null ? [] : [String(value)]}
        onSelectionChange={(keys) => {
          const [key] = [...keys];
          onChange(key === undefined ? null : Number(key));
        }}
      >
        {choices.map((choice) => (
          <ToggleButton key={choice.mark} id={String(choice.mark)} className="min-w-9 tabular-nums">
            {choice.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}
