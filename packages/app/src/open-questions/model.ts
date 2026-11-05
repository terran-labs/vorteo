import {
  questionOptions,
  type AgentQuestion,
  type QuestionAnswerSource,
} from "@getpaseo/protocol/agent-questions";
import type { Agent } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";

export interface QuestionGroups {
  open: AgentQuestion[];
  answered: AgentQuestion[];
}

export interface BlockedTask {
  id: string;
  text: string;
}

/** Open questions keep ask order; answered ones show the latest decision first. Withdrawn ones need no owner. */
export function groupQuestions(questions: readonly AgentQuestion[]): QuestionGroups {
  const open = questions.filter((question) => question.status === "open");
  const answered = questions
    .filter((question) => question.status === "answered")
    .sort((left, right) => (right.answeredAt ?? "").localeCompare(left.answeredAt ?? ""));
  return { open, answered };
}

/** Links resolve against this thread's Vorteo tasks; a deleted task simply drops out. */
export function blockedTasks(question: AgentQuestion, tasks: readonly TodoEntry[]): BlockedTask[] {
  const titles = new Map(
    tasks.flatMap((task) => (task.source === "vorteo" && task.id ? [[task.id, task.text]] : [])),
  );
  return (question.blocks ?? []).flatMap((id) => {
    const text = titles.get(id);
    return text === undefined ? [] : [{ id, text }];
  });
}

const ANSWER_SOURCES: Record<string, string> = {
  mobile: "the Vorteo app",
  browser: "a browser",
};

/** answeredBy is "<client type>:<client id>"; early daemons recorded only "owner". */
export function answeredFrom(answeredBy: string | undefined): string | null {
  const type = answeredBy?.split(":")[0];
  if (!type || type === "owner") return null;
  return ANSWER_SOURCES[type] ?? type;
}

export function openQuestionCount(questions: readonly AgentQuestion[] | undefined): number {
  return questions?.filter((question) => question.status === "open").length ?? 0;
}

export function workspaceOpenQuestionCount(
  agents: Iterable<Pick<Agent, "id" | "workspaceId" | "archivedAt" | "questions">>,
  workspaceId: string,
  pendingArchive: ReadonlySet<string>,
): number {
  let count = 0;
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.archivedAt || pendingArchive.has(agent.id))
      continue;
    count += openQuestionCount(agent.questions);
  }
  return count;
}

export interface ComposedAnswer {
  answer: string;
  optionIds?: string[];
  note?: string;
  source: QuestionAnswerSource;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/**
 * The answer text stays readable on its own, because older daemons and the thread message use
 * only the text. Option IDs, the note and the source ride along for daemons that record them.
 */
export function composeOptionAnswer(
  question: AgentQuestion,
  optionIds: readonly string[],
  note: string,
): ComposedAnswer {
  const options = questionOptions(question.input);
  // Keep the question's option order so the answer reads the same however it was clicked.
  const ordered = options.filter((option) => optionIds.includes(option.id));
  const trimmed = note.trim();
  const labels = ordered.map((option) => option.label).join(", ") || "None";
  return {
    answer: trimmed ? `${labels}. Note: ${trimmed}` : labels,
    optionIds: ordered.map((option) => option.id),
    ...(trimmed ? { note: trimmed } : {}),
    source:
      !trimmed && sameIds(optionIds, question.recommendedOptionIds ?? [])
        ? "recommended"
        : "option",
  };
}

export function composeTextAnswer(question: AgentQuestion, text: string): ComposedAnswer {
  const answer = text.trim();
  const kind = question.input?.kind ?? "text";
  if (kind !== "text") return { answer, source: "other" };
  return {
    answer,
    source: answer === question.recommendedDefault.trim() ? "recommended" : "edited",
  };
}
