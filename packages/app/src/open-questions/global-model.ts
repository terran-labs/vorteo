import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import {
  installationUpdateNeedsOwner,
  type InstallationUpdateEntry,
} from "@/execution-installation/installation-upgrades-model";

/** One host's threads, as the global card reads them from the session store. */
export interface QuestionHostInput {
  serverId: string;
  hostLabel: string;
  agents: Iterable<
    Pick<Agent, "id" | "title" | "workspaceId" | "archivedAt" | "questions" | "tasks"> &
      Partial<
        Pick<
          Agent,
          | "pendingPermissions"
          | "createdByAgentId"
          | "permissionWatchedByCreator"
          | "status"
          | "currentModeId"
          | "availableModes"
          | "cwd"
        >
      >
  >;
  /** The host records who created each thread (server_info.features.agentCreatedBy). */
  approvalsSupported?: boolean;
  workspaces: ReadonlyMap<
    string,
    Pick<WorkspaceDescriptor, "name" | "title" | "projectDisplayName" | "projectCustomName">
  >;
  pendingArchive: ReadonlySet<string>;
}

/** A thread with questions waiting for the owner, labeled for display outside that thread. */
export interface ThreadQuestions {
  key: string;
  serverId: string;
  agentId: string;
  threadTitle: string;
  projectLabel: string | null;
  hostLabel: string | null;
  questions: AgentQuestion[];
  tasks: readonly TodoEntry[];
}

const EMPTY_TASKS: readonly TodoEntry[] = [];

/**
 * Every unanswered question across hosts and projects, grouped by the thread that asked.
 * Threads whose questions block the most tasks come first, then the longest-waiting. Archived
 * threads and threads being archived are left out, matching the sidebar's question badges.
 * Host labels appear only when more than one host has questions.
 */
export function collectThreadQuestions(hosts: readonly QuestionHostInput[]): ThreadQuestions[] {
  const threads: ThreadQuestions[] = [];
  for (const host of hosts) {
    for (const agent of host.agents) {
      if (agent.archivedAt || host.pendingArchive.has(agent.id)) continue;
      const questions = (agent.questions ?? []).filter((question) => question.status === "open");
      if (questions.length === 0) continue;
      const workspace = agent.workspaceId ? host.workspaces.get(agent.workspaceId) : undefined;
      threads.push({
        key: `${host.serverId}:${agent.id}`,
        serverId: host.serverId,
        agentId: agent.id,
        threadTitle: agent.title?.trim() || "Untitled thread",
        projectLabel: workspace ? projectLabel(workspace) : null,
        hostLabel: host.hostLabel,
        questions,
        tasks: agent.tasks ?? EMPTY_TASKS,
      });
    }
  }
  const hostsWithQuestions = new Set(threads.map((thread) => thread.serverId));
  if (hostsWithQuestions.size <= 1) {
    for (const thread of threads) thread.hostLabel = null;
  }
  return threads.sort(compareThreads);
}

/** Thread questions plus an installation update that waits for the owner. */
export function globalOpenQuestionCount(
  threads: readonly ThreadQuestions[],
  update: InstallationUpdateEntry | null = null,
  approvals: readonly ThreadApproval[] = [],
): number {
  const questions = threads.reduce((total, thread) => total + thread.questions.length, 0);
  return questions + approvals.length + (installationUpdateNeedsOwner(update) ? 1 : 0);
}

function projectLabel(
  workspace: Pick<
    WorkspaceDescriptor,
    "name" | "title" | "projectDisplayName" | "projectCustomName"
  >,
): string {
  const project = workspace.projectCustomName?.trim() || workspace.projectDisplayName;
  const name = workspace.title?.trim() || workspace.name;
  return name && name !== project ? `${project} · ${name}` : project;
}

function blockedCount(thread: ThreadQuestions): number {
  return thread.questions.reduce((total, question) => total + (question.blocks?.length ?? 0), 0);
}

function oldestAsk(thread: ThreadQuestions): string {
  return thread.questions.reduce(
    (oldest, question) => (question.askedAt < oldest ? question.askedAt : oldest),
    thread.questions[0]?.askedAt ?? "",
  );
}

function compareThreads(left: ThreadQuestions, right: ThreadQuestions): number {
  const blocked = blockedCount(right) - blockedCount(left);
  if (blocked !== 0) return blocked;
  return oldestAsk(left).localeCompare(oldestAsk(right));
}

/** A thread stopped on a tool approval that no supervising thread can answer. */
export interface ThreadApproval {
  key: string;
  serverId: string;
  agentId: string;
  threadTitle: string;
  projectLabel: string | null;
  modeLabel: string | null;
  cwd: string | null;
  request: AgentPermissionRequest;
}

type RoutingAgent = Pick<Agent, "id" | "archivedAt"> &
  Partial<
    Pick<Agent, "createdByAgentId" | "permissionWatchedByCreator" | "status" | "pendingPermissions">
  >;

/**
 * Whether a thread's approval is the owner's to answer. The creator is the one the daemon
 * recorded, never a label. A creator answers only if it will be told: it must still hold a finish
 * subscription for the thread (the daemon's permissionWatchedByCreator), and it must be able to
 * act (not closed, archived, missing, or itself waiting on an approval). Otherwise the question
 * passes up the creator chain; with no such ancestor left, the approval is the owner's.
 */
export function approvalBelongsToOwner(
  agentId: string,
  agents: ReadonlyMap<string, RoutingAgent>,
): boolean {
  const seen = new Set<string>([agentId]);
  let current = agents.get(agentId);
  while (current?.createdByAgentId) {
    const creatorId = current.createdByAgentId;
    if (seen.has(creatorId)) return true;
    seen.add(creatorId);
    const creator = agents.get(creatorId);
    if (!creator) return true;
    const canAnswer =
      current.permissionWatchedByCreator === true &&
      !creator.archivedAt &&
      creator.status !== "closed" &&
      (creator.pendingPermissions?.length ?? 0) === 0;
    if (canAnswer) return false;
    current = creator;
  }
  return true;
}

/** An approval the daemon flagged as waiting too long for a supervising thread (#659). */
function escalatedToOwner(request: AgentPermissionRequest): boolean {
  return request.metadata?.ownerEscalated === true;
}

/**
 * Every pending approval the owner has to answer, across hosts: tool, plan, mode and other kinds. Only hosts that record
 * creators take part; elsewhere approvals stay in their own threads, as before.
 */
export function collectThreadApprovals(hosts: readonly QuestionHostInput[]): ThreadApproval[] {
  const approvals: ThreadApproval[] = [];
  for (const host of hosts) {
    if (!host.approvalsSupported) continue;
    const agents = [...host.agents];
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    for (const agent of agents) {
      if (agent.archivedAt || host.pendingArchive.has(agent.id)) continue;
      // Every kind except a question blocks the thread the same way; questions have their own card.
      const blocking = (agent.pendingPermissions ?? []).filter(
        (request) => request.kind !== "question",
      );
      if (blocking.length === 0) continue;
      const ownersThread = approvalBelongsToOwner(agent.id, byId);
      const requests = ownersThread ? blocking : blocking.filter(escalatedToOwner);
      if (requests.length === 0) continue;
      const workspace = agent.workspaceId ? host.workspaces.get(agent.workspaceId) : undefined;
      const modeLabel = agent.currentModeId
        ? (agent.availableModes?.find((mode) => mode.id === agent.currentModeId)?.label ??
          agent.currentModeId)
        : null;
      for (const request of requests) {
        approvals.push({
          key: `${host.serverId}:${agent.id}:${request.id}`,
          serverId: host.serverId,
          agentId: agent.id,
          threadTitle: agent.title?.trim() || "Untitled thread",
          projectLabel: workspace ? projectLabel(workspace) : null,
          modeLabel,
          cwd: agent.cwd ?? null,
          request,
        });
      }
    }
  }
  return approvals;
}

/**
 * Above this many lines the card offers only Open thread: a fling can scroll a very long command
 * to its end without anyone reading it.
 */
export const MAX_ACCEPT_LINES = 200;

/**
 * Shows characters that could make the text read differently from what runs: control characters
 * (a carriage return can overprint a line) and format characters (bidirectional overrides,
 * zero-width spaces), as visible escapes such as ⟨U+202E⟩. Newlines and tabs stay.
 */
export function visibleText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) =>
    char === "\n" || char === "\t"
      ? char
      : `⟨U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
}
