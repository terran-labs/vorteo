import { createHash } from "node:crypto";
import {
  questionAllowsOther,
  questionOptions,
  type AgentQuestion,
  type QuestionAnswerSource,
  type QuestionInput,
  type QuestionMutation,
} from "@getpaseo/protocol/agent-questions";

const MAX_QUESTIONS = 200;
/** Closed questions beyond this many are pruned once answers are delivered. */
const RETAINED_CLOSED_QUESTIONS = 20;
const MIN_DEFAULT_WINDOW_MS = 15 * 60_000;

export class QuestionError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "QuestionError";
  }
}

export const QUESTION_GUIDANCE =
  "Ask the owner with update_questions only when a decision genuinely needs them and cannot be resolved from the request, code, or sensible defaults. Keep the question short, explain why it matters in why, list the checklist task IDs it blocks, and always give recommendedDefault. Prefer input kind confirm for yes or no decisions and choice or multi for named alternatives, with recommendedOptionIds; use free text only for open-ended answers. Continue independent work while waiting. The owner's answer arrives as a message in this thread. If defaultAppliesAfter passes without an answer, you may proceed with the recommended default; record that in the journal and leave the question open so the owner can still override it. Withdraw a question as soon as it no longer needs the owner. Never answer your own question.";

interface AskContext {
  askedBy: string;
  now: string;
  taskIds: ReadonlySet<string>;
}

/** What the owner's client sends. Option fields come only from clients that render typed inputs. */
export interface OwnerAnswerInput {
  questionId: string;
  answer: string;
  answeredBy: string;
  optionIds?: string[];
  note?: string;
  source?: QuestionAnswerSource;
}

interface OwnerAnswer extends OwnerAnswerInput {
  now: string;
}

export interface AnsweredQuestions {
  questions: AgentQuestion[];
  answered: AgentQuestion;
}

function requireTasks(blocks: string[] | undefined, taskIds: ReadonlySet<string>): void {
  const missing = blocks?.find((id) => !taskIds.has(id));
  if (missing !== undefined)
    throw new QuestionError("invalid", `Checklist task ${missing} does not exist in this thread.`);
}

type AskedFields = Pick<
  AgentQuestion,
  | "id"
  | "question"
  | "why"
  | "recommendedDefault"
  | "blocks"
  | "defaultAppliesAfter"
  | "input"
  | "recommendedOptionIds"
>;

/** Field order is fixed so retried asks compare by value. */
function askedFields(question: AskedFields): string {
  return JSON.stringify([
    question.id,
    question.question,
    question.why,
    question.recommendedDefault,
    question.blocks ?? [],
    question.defaultAppliesAfter ?? null,
    question.input ?? null,
    question.recommendedOptionIds ?? null,
  ]);
}

function requireOptionIds(input: QuestionInput | undefined, ids: string[], label: string): void {
  const known = new Set(questionOptions(input).map((option) => option.id));
  const unknown = ids.find((id) => !known.has(id));
  if (unknown !== undefined)
    throw new QuestionError(
      "invalid",
      `${label} ${unknown} is not one of this question's options.`,
    );
  if (new Set(ids).size !== ids.length)
    throw new QuestionError("invalid", `${label}s must not repeat.`);
}

/** Button questions need distinct options and a valid recommendation the owner can click. */
function requireInput(
  input: QuestionInput | undefined,
  recommendedOptionIds: string[] | undefined,
): void {
  if (!input || input.kind === "text") {
    if (recommendedOptionIds?.length)
      throw new QuestionError("invalid", "Free-text questions have no options to recommend.");
    return;
  }
  const options = questionOptions(input);
  if (new Set(options.map((option) => option.id)).size !== options.length)
    throw new QuestionError("invalid", "Option IDs must be unique.");
  if (!recommendedOptionIds?.length)
    throw new QuestionError(
      "invalid",
      "Give recommendedOptionIds with the option you recommend for confirm, choice and multi questions.",
    );
  requireOptionIds(input, recommendedOptionIds, "Recommended option");
  if (input.kind !== "multi" && recommendedOptionIds.length !== 1)
    throw new QuestionError(
      "invalid",
      "Recommend exactly one option for confirm and choice questions.",
    );
  if (input.kind === "multi") {
    const min = input.min ?? 0;
    const max = Math.min(input.max ?? options.length, options.length);
    if (min > max) throw new QuestionError("invalid", "min must not exceed max.");
    if (recommendedOptionIds.length < min || recommendedOptionIds.length > max)
      throw new QuestionError(
        "invalid",
        `Recommend between ${min} and ${max} options for this multi question.`,
      );
  }
}

/** Selected options must fit the question; free text is allowed only where Other is offered. */
function requireAnswerFits(question: AgentQuestion, input: OwnerAnswer): void {
  const selected = input.optionIds ?? [];
  const kind = question.input?.kind ?? "text";
  if (kind === "text") {
    if (selected.length)
      throw new QuestionError("invalid", "This question takes a written answer, not options.");
    return;
  }
  // Clients without typed inputs send only text; accept it so older apps can still answer.
  if (selected.length === 0 && input.source === undefined) return;
  requireOptionIds(question.input, selected, "Option");
  if (input.source === "other") {
    if (!questionAllowsOther(question.input))
      throw new QuestionError("invalid", "This question does not accept an Other answer.");
    return;
  }
  if (kind !== "multi" && selected.length !== 1)
    throw new QuestionError("invalid", "Choose exactly one option.");
  if (question.input?.kind === "multi") {
    const total = questionOptions(question.input).length;
    const min = question.input.min ?? 0;
    const max = Math.min(question.input.max ?? total, total);
    if (selected.length < min || selected.length > max)
      throw new QuestionError("invalid", `Choose between ${min} and ${max} options.`);
  }
}

/** The owner needs a real chance to answer before an agent proceeds on its default. */
function requireDefaultWindow(defaultAppliesAfter: string | null | undefined, now: string): void {
  if (!defaultAppliesAfter) return;
  if (Date.parse(defaultAppliesAfter) - Date.parse(now) < MIN_DEFAULT_WINDOW_MS)
    throw new QuestionError(
      "invalid",
      "defaultAppliesAfter must be at least 15 minutes after the question is asked or updated.",
    );
}

function closedAt(question: AgentQuestion): string {
  return question.answeredAt ?? question.askedAt;
}

/** Keep open and undelivered questions, plus the newest closed ones. */
function retainQuestions(questions: AgentQuestion[]): AgentQuestion[] {
  const pending = (question: AgentQuestion) =>
    question.status === "open" || (question.status === "answered" && !question.answerDeliveredAt);
  const closed = questions.filter((question) => !pending(question));
  if (closed.length <= RETAINED_CLOSED_QUESTIONS) return questions;
  const kept = new Set(
    closed
      .sort((left, right) => closedAt(right).localeCompare(closedAt(left)))
      .slice(0, RETAINED_CLOSED_QUESTIONS),
  );
  return questions.filter((question) => pending(question) || kept.has(question));
}

/** Withdrawn questions need no owner, so snapshots omit them. */
export function snapshotQuestions(
  questions: AgentQuestion[] | undefined,
): AgentQuestion[] | undefined {
  return questions?.filter((question) => question.status !== "withdrawn");
}

function requireQuestion(questions: AgentQuestion[], id: string): AgentQuestion {
  const question = questions.find((item) => item.id === id);
  if (!question) throw new QuestionError("not_found", `Question ${id} does not exist.`);
  return question;
}

function replaceQuestion(questions: AgentQuestion[], next: AgentQuestion): AgentQuestion[] {
  return questions.map((item) => (item.id === next.id ? next : item));
}

/** Agents ask, revise, and withdraw. Only the owner's RPC can answer. */
export function mutateQuestions(
  questions: AgentQuestion[],
  mutation: QuestionMutation,
  context: AskContext,
): AgentQuestion[] {
  if (mutation.operation === "ask") {
    requireTasks(mutation.blocks, context.taskIds);
    requireInput(mutation.input, mutation.recommendedOptionIds);
    const previous = questions.find((item) => item.id === mutation.id);
    if (previous) {
      if (askedFields(previous) !== askedFields(mutation))
        throw new QuestionError(
          "conflict",
          "This question ID was already used for a different question. Ask with a fresh UUID.",
        );
      return questions;
    }
    requireDefaultWindow(mutation.defaultAppliesAfter, context.now);
    if (questions.length >= MAX_QUESTIONS)
      throw new QuestionError("invalid", "This thread already has too many questions.");
    const asked: AgentQuestion = {
      id: mutation.id,
      question: mutation.question,
      why: mutation.why,
      recommendedDefault: mutation.recommendedDefault,
      ...(mutation.blocks ? { blocks: mutation.blocks } : {}),
      ...(mutation.defaultAppliesAfter
        ? { defaultAppliesAfter: mutation.defaultAppliesAfter }
        : {}),
      ...(mutation.input ? { input: mutation.input } : {}),
      ...(mutation.recommendedOptionIds?.length
        ? { recommendedOptionIds: mutation.recommendedOptionIds }
        : {}),
      askedAt: context.now,
      askedBy: context.askedBy,
      status: "open",
    };
    return [...questions, asked];
  }
  const question = requireQuestion(questions, mutation.id);
  if (mutation.operation === "withdraw") {
    if (question.status === "withdrawn") return questions;
    if (question.status === "answered")
      throw new QuestionError("conflict", "The owner already answered this question.");
    return retainQuestions(replaceQuestion(questions, { ...question, status: "withdrawn" }));
  }
  return updateQuestion(questions, question, mutation, context);
}

function updateQuestion(
  questions: AgentQuestion[],
  question: AgentQuestion,
  mutation: Extract<QuestionMutation, { operation: "update" }>,
  context: AskContext,
): AgentQuestion[] {
  if (question.status !== "open")
    throw new QuestionError(
      "conflict",
      `Only open questions can be updated; this one is ${question.status}.`,
    );
  requireTasks(mutation.blocks, context.taskIds);
  requireDefaultWindow(mutation.defaultAppliesAfter, context.now);
  const input = mutation.input ?? question.input;
  // A new input invalidates the old recommendation, so it must come with its own.
  const recommendedOptionIds =
    mutation.recommendedOptionIds ?? (mutation.input ? undefined : question.recommendedOptionIds);
  requireInput(input, recommendedOptionIds);
  const {
    defaultAppliesAfter: _previous,
    input: _input,
    recommendedOptionIds: _recommended,
    ...revisable
  } = question;
  const defaultAppliesAfter =
    mutation.defaultAppliesAfter === undefined
      ? question.defaultAppliesAfter
      : mutation.defaultAppliesAfter;
  const updated: AgentQuestion = {
    ...revisable,
    question: mutation.question ?? question.question,
    why: mutation.why ?? question.why,
    recommendedDefault: mutation.recommendedDefault ?? question.recommendedDefault,
    ...(mutation.blocks ? { blocks: mutation.blocks } : {}),
    ...(defaultAppliesAfter ? { defaultAppliesAfter } : {}),
    ...(input ? { input } : {}),
    ...(recommendedOptionIds?.length ? { recommendedOptionIds } : {}),
  };
  return replaceQuestion(questions, updated);
}

/** Repeating the same answer is idempotent so a lost response can be retried. */
export function answerQuestion(questions: AgentQuestion[], input: OwnerAnswer): AnsweredQuestions {
  const question = requireQuestion(questions, input.questionId);
  if (question.status === "withdrawn")
    throw new QuestionError(
      "conflict",
      "The agent withdrew this question; it no longer needs an answer.",
    );
  if (question.status === "answered") {
    if (question.answer !== input.answer)
      throw new QuestionError("conflict", "This question was already answered.");
    return { questions, answered: question };
  }
  requireAnswerFits(question, input);
  const note = input.note?.trim();
  const answered: AgentQuestion = {
    ...question,
    status: "answered",
    answer: input.answer,
    answeredAt: input.now,
    answeredBy: input.answeredBy,
    ...(input.optionIds?.length ? { answerOptionIds: input.optionIds } : {}),
    ...(note ? { answerNote: note } : {}),
    ...(input.source ? { answerSource: input.source } : {}),
  };
  return { questions: replaceQuestion(questions, answered), answered };
}

/** Recorded only after the answer message is durably queued. */
export function markAnswerDelivered(
  questions: AgentQuestion[],
  questionId: string,
  now: string,
): AgentQuestion[] {
  const question = requireQuestion(questions, questionId);
  if (question.answerDeliveredAt) return questions;
  return retainQuestions(replaceQuestion(questions, { ...question, answerDeliveredAt: now }));
}

/** A stable journal entry ID makes answer retries append at most one entry. */
export function answerJournalEntryId(questionId: string): string {
  const hex = createHash("sha256").update(`question-answer:${questionId}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16,
  )}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const SOURCE_TEXT: Record<QuestionAnswerSource, string> = {
  recommended: "The owner accepted your recommendation.",
  edited: "The owner edited your recommendation before sending it.",
  option: "The owner chose from your options.",
  other: "The owner rejected your options and wrote their own answer.",
};

export function answerMessage(question: AgentQuestion): string {
  const lines = [`Question: ${question.question}`, `Answer: ${question.answer}`];
  if (question.answerOptionIds?.length)
    lines.push(`Selected option IDs: ${question.answerOptionIds.join(", ")}`);
  if (question.answerNote && !question.answer?.includes(question.answerNote))
    lines.push(`Note: ${question.answerNote}`);
  if (question.answerSource) lines.push(SOURCE_TEXT[question.answerSource]);
  return `The owner answered your open question.\n\n${lines.join(
    "\n",
  )}\n\nContinue the work this question blocked, following this answer.`;
}

export function answerJournalText(question: AgentQuestion): string {
  return `Owner answered "${question.question}": ${question.answer}`;
}
