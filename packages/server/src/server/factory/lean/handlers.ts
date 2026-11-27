import { createHash, randomUUID } from "node:crypto";
import {
  factoryLeanAccept,
  factoryLeanActivityList,
  factoryLeanAnswer,
  factoryLeanAsk,
  factoryLeanDecide,
  factoryLeanEscalate,
  factoryLeanIntentSet,
  factoryLeanRulesAdd,
  factoryLeanRulesList,
  factoryLeanRulesRemove,
  factoryLeanSendBack,
  factoryLeanStatus,
  type FactoryLeanStatus,
} from "@getpaseo/server/factory-lean";
import { FACTORY_OWNER_ONLY_CODE, FactoryRefusal } from "../project/owner-writes.js";
import type { createAcceptance } from "./acceptance.js";
import {
  RevisionConflictError,
  type ActivityLog,
  type Escalation,
  type IntentStore,
  type LeanLedger,
  type LeanStateStore,
  type RoutedEvent,
  type RunnerRef,
} from "./types.js";

const contracts = [
  factoryLeanStatus,
  factoryLeanActivityList,
  factoryLeanDecide,
  factoryLeanEscalate,
  factoryLeanAnswer,
  factoryLeanAccept,
  factoryLeanSendBack,
  factoryLeanAsk,
  factoryLeanIntentSet,
  factoryLeanRulesList,
  factoryLeanRulesAdd,
  factoryLeanRulesRemove,
] as const;

const methods: ReadonlySet<string> = new Set(contracts.map(({ name }) => name));

interface SessionDecision {
  eventIds: string[];
  expectedRevision: number;
}

type DecideInput = ReturnType<typeof factoryLeanDecide.input.parse>;
type EscalationInput = ReturnType<typeof factoryLeanEscalate.input.parse>;
type AskInput = ReturnType<typeof factoryLeanAsk.input.parse>;

export interface LeanProjectRuntime {
  state: LeanStateStore;
  acceptance: ReturnType<typeof createAcceptance>;
  activity: ActivityLog;
  intent: IntentStore;
  status(): Promise<FactoryLeanStatus>;
  holdsIntake(): Promise<boolean>;
  /** Check daemon-owned assignments, including the current local operational session. */
  sessionOwnsEvent(runner: RunnerRef, eventId: string): Promise<boolean>;
  /** Persist the decision and event consumption together using expectedRevision. Effects use eventIds as replay keys. */
  decide(
    input: SessionDecision & {
      decision: DecideInput["decision"];
      runner: RunnerRef;
    },
  ): Promise<ReturnType<typeof factoryLeanDecide.output.parse>>;
  /** Dedupe notifications by escalation ID, including when replayed after a restart. */
  notifyEscalation(escalation: Escalation): Promise<void>;
  /** Apply or enqueue the recorded owner answer with escalation ID as the effect key. */
  applyAnswer(escalation: Escalation): Promise<void>;
}

export type LeanRuntimeRegistry = (projectId: string) => LeanProjectRuntime | null;

interface SocketCaller {
  principalId: string | null | undefined;
  credential: string | null;
}

type Caller = { kind: "owner" } | { kind: "reader" } | { kind: "agent"; agentId: string };

const operationalOnly = "Only the assigned Lead session can decide these events.";
const intakeOnly = "Retry this change on the Factory intake lane holder.";

function isOperationalRunner(runner: LeanLedger["runners"][string] | undefined): boolean {
  return runner?.role === "foreman-op" && runner.serverId === null && runner.closedAt === null;
}

function requireOwner(caller: Caller): void {
  if (caller.kind !== "owner") {
    throw new FactoryRefusal(
      "This operation requires a verified installation owner session.",
      FACTORY_OWNER_ONLY_CODE,
    );
  }
}

function belongsToIssue(events: RoutedEvent[], issue: number): boolean {
  return events.some((event) => event.issue === issue);
}

function createEscalation(input: EscalationInput | AskInput, now: Date): Escalation {
  const ownerEscalation = "blocksIssues" in input;
  const kind = ownerEscalation ? "escalation" : "intent-question";
  const eventIds = [...input.eventIds].sort();
  const id = createHash("sha256")
    .update(JSON.stringify([kind, eventIds]))
    .digest("hex");
  return {
    id,
    kind,
    question: input.question,
    why: ownerEscalation ? input.why : "The Lead needs clarification about the approved intent.",
    options: ownerEscalation ? input.options : [],
    recommended: ownerEscalation ? input.recommended : "",
    blocksIssues: ownerEscalation ? input.blocksIssues : [input.issue],
    eventIds,
    openedAt: now.toISOString(),
    answeredAt: null,
    answer: null,
  };
}

async function assignedEvents(
  runtime: LeanProjectRuntime,
  runner: RunnerRef,
  pending: LeanLedger["pendingEvents"],
  ids: string[],
): Promise<RoutedEvent[] | null> {
  if (new Set(ids).size !== ids.length) return null;
  const events = [];
  for (const id of ids) {
    const entry = pending.find(({ routed }) => routed.id === id);
    if (entry?.deliveredAt == null || entry.routed.class !== "judgment") return null;
    if (!(await runtime.sessionOwnsEvent(runner, id))) return null;
    events.push(entry.routed);
  }
  return events;
}

export function createLeanHandlers(
  registry: LeanRuntimeRegistry,
  now: () => Date = () => new Date(),
) {
  async function answer(
    runtime: LeanProjectRuntime,
    { projectId, escalationId, decision }: ReturnType<typeof factoryLeanAnswer.input.parse>,
  ) {
    const escalation = await runtime.state.mutate(projectId, (ledger) => {
      const entry = ledger.escalations.find(({ id }) => id === escalationId);
      if (!entry) return null;
      if (entry.answeredAt !== null && entry.answer !== decision) return null;
      entry.answeredAt ??= now().toISOString();
      entry.answer = decision;
      return entry;
    });
    if (!escalation)
      return { refused: "That Factory question is missing or already has a different answer." };
    await runtime.applyAnswer(escalation);
    return { applied: true };
  }

  async function writeOwner(
    runtime: LeanProjectRuntime,
    method: string,
    raw: unknown,
  ): Promise<unknown> {
    switch (method) {
      case factoryLeanAnswer.name:
        return answer(runtime, factoryLeanAnswer.input.parse(raw));
      case factoryLeanIntentSet.name: {
        const { projectId, ...record } = factoryLeanIntentSet.input.parse(raw);
        const previous = (await runtime.state.read(projectId)).intent[record.issue];
        if (
          previous?.notes !== record.notes ||
          JSON.stringify(previous.quotes) !== JSON.stringify(record.quotes)
        ) {
          await runtime.intent.setIntent(record);
        }
        return { revision: (await runtime.state.read(projectId)).revision };
      }
      case factoryLeanRulesAdd.name: {
        const { projectId, ...rule } = factoryLeanRulesAdd.input.parse(raw);
        // Check and add in one daemon transaction so retries cannot create duplicate rules.
        return runtime.state.mutate(projectId, (ledger) => {
          const prior = ledger.rules.find(
            (entry) =>
              entry.scope === rule.scope &&
              entry.text === rule.text &&
              entry.ownerQuote === rule.ownerQuote,
          );
          if (prior) return prior;
          const entry = { ...rule, id: randomUUID(), addedAt: now().toISOString() };
          ledger.rules.push(entry);
          return entry;
        });
      }
      case factoryLeanRulesRemove.name:
        return {
          removed: await runtime.intent.removeRule(factoryLeanRulesRemove.input.parse(raw).ruleId),
        };
      default:
        throw new Error("Unknown Factory owner operation.");
    }
  }

  async function escalate(
    runtime: LeanProjectRuntime,
    proposed: Escalation,
    input: EscalationInput | AskInput,
  ) {
    const { projectId, expectedRevision } = input;
    const before = await runtime.state.read(projectId);
    const existing = before.escalations.find(({ id }) => id === proposed.id);
    if (existing) {
      if (
        JSON.stringify({
          ...existing,
          openedAt: proposed.openedAt,
          answeredAt: null,
          answer: null,
        }) !== JSON.stringify(proposed)
      ) {
        return { refused: "These Factory events already have a different question." };
      }
      if (existing.answeredAt === null) await runtime.notifyEscalation(existing);
      return { escalationId: existing.id };
    }

    const result = await runtime.state.mutate(
      projectId,
      (ledger) => {
        if (proposed.eventIds.some((id) => Object.hasOwn(ledger.answeredEvents, id))) return null;
        ledger.escalations.push(proposed);
        if (proposed.kind === "escalation") {
          for (const id of proposed.eventIds) ledger.answeredEvents[id] = proposed.openedAt;
        }
        return proposed;
      },
      expectedRevision,
    );
    if (!result) return { refused: "These Factory events already have a decision." };
    await runtime.notifyEscalation(result);
    return { escalationId: result.id };
  }

  async function decide(
    runtime: LeanProjectRuntime,
    ledger: LeanLedger,
    runner: RunnerRef,
    { decision, eventIds, expectedRevision }: DecideInput,
  ) {
    const events = await assignedEvents(runtime, runner, ledger.pendingEvents, eventIds);
    if (!events) return { refused: operationalOnly };
    const issues = "issue" in decision ? [decision.issue] : decision.relatesTo;
    if (!issues.every((issue) => belongsToIssue(events, issue))) {
      return { refused: "Limit the decision to issues named by the assigned events." };
    }
    if (eventIds.some((id) => Object.hasOwn(ledger.answeredEvents, id))) {
      return { applied: false, revision: ledger.revision };
    }
    if (expectedRevision !== ledger.revision) {
      return { refused: new RevisionConflictError(expectedRevision, ledger.revision).message };
    }
    return runtime.decide({ decision, eventIds, expectedRevision, runner });
  }

  async function agentOperation(
    runtime: LeanProjectRuntime,
    ledger: LeanLedger,
    runner: RunnerRef,
    method: string,
    raw: unknown,
  ): Promise<unknown> {
    if (!(await runtime.holdsIntake())) return { refused: intakeOnly };

    switch (method) {
      case factoryLeanAccept.name: {
        const { issue, sha, eventIds, expectedRevision } = factoryLeanAccept.input.parse(raw);
        return runtime.acceptance.accept(issue, sha, runner, { eventIds, expectedRevision });
      }
      case factoryLeanSendBack.name: {
        const { issue, sha, improvements, eventIds, expectedRevision } =
          factoryLeanSendBack.input.parse(raw);
        return runtime.acceptance.sendBack(issue, sha, improvements, runner, {
          eventIds,
          expectedRevision,
        });
      }
      case factoryLeanDecide.name:
        return decide(runtime, ledger, runner, factoryLeanDecide.input.parse(raw));
      case factoryLeanEscalate.name:
      case factoryLeanAsk.name: {
        const input =
          method === factoryLeanAsk.name
            ? factoryLeanAsk.input.parse(raw)
            : factoryLeanEscalate.input.parse(raw);
        const events = await assignedEvents(runtime, runner, ledger.pendingEvents, input.eventIds);
        if (!events) return { refused: operationalOnly };
        if ("issue" in input) {
          const { issue } = input;
          const [assigned] = events;
          if (
            events.length !== 1 ||
            assigned?.event.kind !== "reviewed-green" ||
            assigned.issue !== issue
          ) {
            return { refused: "Ask about the reviewed issue in this acceptance session." };
          }
        } else if (
          !input.blocksIssues.every((issue) => belongsToIssue(events, issue)) ||
          !input.options.includes(input.recommended)
        ) {
          return {
            refused: "Use issues named by the assigned events and recommend one of the options.",
          };
        }
        return escalate(runtime, createEscalation(input, now()), input);
      }
      default:
        return { refused: operationalOnly };
    }
  }

  async function invoke(caller: Caller, method: string, raw: unknown): Promise<unknown> {
    const contract = contracts.find(({ name }) => name === method);
    if (!contract) throw new Error("Unknown Lean Factory operation.");
    const input = contract.input.parse(raw);
    const { projectId } = input;
    const runtime = registry(projectId);
    if (!runtime) throw new Error("Lean Factory is unavailable in that project.");

    const ledger = caller.kind === "agent" ? await runtime.state.read(projectId) : null;
    const runner = caller.kind === "agent" ? ledger?.runners[caller.agentId] : undefined;
    if (ledger && !isOperationalRunner(runner)) {
      throw new FactoryRefusal(operationalOnly, "factory_session_required");
    }

    switch (method) {
      case factoryLeanStatus.name:
        return factoryLeanStatus.output.parse(await runtime.status());
      case factoryLeanActivityList.name:
        return factoryLeanActivityList.output.parse(
          await runtime.activity.list(factoryLeanActivityList.input.parse(raw)),
        );
      case factoryLeanRulesList.name:
        requireOwner(caller);
        return factoryLeanRulesList.output.parse({
          rules: (await runtime.state.read(projectId)).rules,
        });
      case factoryLeanAnswer.name:
      case factoryLeanIntentSet.name:
      case factoryLeanRulesAdd.name:
      case factoryLeanRulesRemove.name:
        requireOwner(caller);
        if (!(await runtime.holdsIntake()))
          throw new FactoryRefusal(intakeOnly, "factory_intake_required");
        return contract.output.parse(await writeOwner(runtime, method, raw));
      default:
        if (!ledger || !runner) return { refused: operationalOnly };
        try {
          return contract.output.parse(await agentOperation(runtime, ledger, runner, method, raw));
        } catch (error) {
          if (error instanceof RevisionConflictError) return { refused: error.message };
          throw error;
        }
    }
  }

  return {
    async invokeSocket(method: string, raw: unknown, caller?: SocketCaller): Promise<unknown> {
      // A WebSocket owner principal label can also come from local, open or forwarded access.
      // Password admission is sufficient for the read surface only.
      if (caller?.principalId !== "owner" || caller.credential !== "password") {
        throw new FactoryRefusal(
          "This connection cannot read Lean Factory.",
          "factory_session_required",
        );
      }
      return invoke({ kind: "reader" }, method, raw);
    },
    invokeAgent(agentId: string, method: string, raw: unknown): Promise<unknown> {
      return invoke({ kind: "agent", agentId }, method, raw);
    },
    /** For an in-process ingress that already verified the installation owner session. */
    invokeOwner(method: string, raw: unknown): Promise<unknown> {
      return invoke({ kind: "owner" }, method, raw);
    },
  };
}

export type LeanHandlers = ReturnType<typeof createLeanHandlers>;

export function isLeanFactoryMethod(method: string): boolean {
  return methods.has(method);
}
