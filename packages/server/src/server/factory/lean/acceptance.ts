import { acceptanceEventId } from "./router.js";
import {
  RevisionConflictError,
  type Acceptance,
  type AcceptanceBrief,
  type AcceptancePort,
  type Escalation,
  type IntentStore,
  type LeanLedger,
  type LeanStateStore,
  type RunnerRef,
} from "./types.js";

interface AcceptanceCandidate {
  /** A fresh trusted issue, same-repository pull and approved review, with passing checks. */
  sha: string;
  labels: string[];
  brief: Omit<AcceptanceBrief, "issue" | "intent" | "rules" | "sendBackRound">;
}

interface AcceptanceEffects {
  /** Re-resolve all candidate facts on every call. Return null when the acceptance gates fail. */
  candidate(issue: number): Promise<AcceptanceCandidate | null>;
  /** Check the current intake lane fence. The write adapters also fence their own operations. */
  holdsIntake(): Promise<boolean>;
  /** Check the daemon's session assignment, with identity obtained from the authenticated caller. */
  sessionOwnsEvent(session: RunnerRef, eventId: string): Promise<boolean>;
  /** Each operation is idempotent under eventId, including across daemon restarts. */
  publishAcceptance(input: {
    issue: number;
    eventId: string;
    acceptance: Acceptance;
  }): Promise<void>;
  postSendBack(input: { issue: number; eventId: string; body: string }): Promise<void>;
  /** Deliver the exact text to the lead, reopening it if needed. Reject if delivery is pending. */
  deliverSendBack(input: { issue: number; eventId: string; text: string }): Promise<void>;
  notifyEscalation(escalation: Escalation): Promise<void>;
}

interface DecisionContext {
  eventIds: readonly string[];
  expectedRevision: number;
}

type Decision = { accepted: boolean } | { round: number; escalated: boolean } | { refused: string };

const sessionRefusal = "Only the assigned Lead session can decide this event.";

function validateDecision(sha: string, eventId: string, context?: DecisionContext): string | null {
  if (!/^[a-f0-9]{40}$/.test(sha)) return "Use the full pull request head SHA.";
  if (context && (context.eventIds.length !== 1 || context.eventIds[0] !== eventId)) {
    return "Use the acceptance event for this issue and commit.";
  }
  return null;
}

function decisionResult(outcome: Acceptance["outcome"], round: number): Decision {
  return outcome === "accepted"
    ? { accepted: true }
    : { round, escalated: outcome === "escalated" };
}

function canRecord(ledger: LeanLedger, issue: number, sha: string, session: RunnerRef): boolean {
  const eventId = acceptanceEventId(issue, sha);
  const runner = ledger.runners[session.agentId];
  const pending = ledger.pendingEvents.find(({ routed }) => routed.id === eventId);
  const event = pending?.routed.event;
  return (
    runner?.closedAt === null &&
    sameSession(runner, session) &&
    pending?.deliveredAt != null &&
    event?.kind === "reviewed-green" &&
    event.issue === issue &&
    event.sha === sha &&
    !Object.hasOwn(ledger.answeredEvents, eventId) &&
    !ledger.escalations.some(
      (entry) => entry.answeredAt === null && entry.blocksIssues.includes(issue),
    ) &&
    !ledger.acceptances[issue]?.some((existing) => existing.sha === sha)
  );
}

function sameSession(recorded: RunnerRef, caller: RunnerRef): boolean {
  return (
    recorded.agentId === caller.agentId &&
    recorded.serverId === caller.serverId &&
    recorded.role === "foreman-op" &&
    caller.role === "foreman-op"
  );
}

interface DaemonAcceptance extends AcceptancePort {
  accept: (
    issue: number,
    sha: string,
    session: RunnerRef,
    context?: DecisionContext,
  ) => ReturnType<AcceptancePort["accept"]>;
  sendBack: (
    issue: number,
    sha: string,
    improvements: string[],
    session: RunnerRef,
    context?: DecisionContext,
  ) => ReturnType<AcceptancePort["sendBack"]>;
  /** Replay post-commit effects for this issue's current head after a transient failure. */
  recover(issue: number): Promise<void>;
}

export function createAcceptance(input: {
  projectId: string;
  state: LeanStateStore;
  intent: IntentStore;
  effects: AcceptanceEffects;
  now?: () => Date;
}): DaemonAcceptance {
  const { projectId, state, effects } = input;
  const now = input.now ?? (() => new Date());

  async function publish(issue: number, record: Acceptance, escalation: Escalation | undefined) {
    if (!(await effects.holdsIntake()))
      throw new Error("The intake lane moved. Retry on its holder.");
    const eventId = acceptanceEventId(issue, record.sha);
    if (record.outcome === "accepted") {
      await effects.publishAcceptance({ issue, eventId, acceptance: record });
    } else if (record.outcome === "sent-back") {
      const text = record.improvements.map((line, index) => `${index + 1}. ${line}`).join("\n");
      const body = `${text}\n\n<!-- factory-sendback v1 sha=${record.sha} -->`;
      await effects.postSendBack({ issue, eventId, body });
      await effects.deliverSendBack({ issue, eventId, text });
    } else {
      if (!escalation) throw new Error("The Factory escalation is missing from the ledger.");
      await effects.notifyEscalation(escalation);
    }
  }

  async function currentCandidate(issue: number, sha: string) {
    const candidate = await effects.candidate(issue);
    const verdict = candidate?.brief.verdict;
    return candidate?.sha === sha && verdict?.approved && verdict.sha === sha ? candidate : null;
  }

  async function replay(
    ledger: LeanLedger,
    issue: number,
    previous: Acceptance,
    decision: {
      outcome: Acceptance["outcome"];
      improvements: string[] | null;
      session: RunnerRef;
      round: number;
    },
  ): Promise<Decision> {
    if (
      previous.session !== decision.session.agentId ||
      previous.outcome !== decision.outcome ||
      JSON.stringify(previous.improvements) !== JSON.stringify(decision.improvements ?? [])
    ) {
      return { refused: "This commit already has an acceptance decision." };
    }
    const eventId = acceptanceEventId(issue, previous.sha);
    const escalation = ledger.escalations.find((entry) => entry.eventIds.includes(eventId));
    if (!escalation?.answeredAt) await publish(issue, previous, escalation);
    return decisionResult(previous.outcome, decision.round);
  }

  async function persistDecision(
    issue: number,
    session: RunnerRef,
    record: Acceptance,
    escalation: Escalation | undefined,
    revision: number,
  ): Promise<{ refused: string } | null> {
    const eventId = acceptanceEventId(issue, record.sha);
    try {
      const applied = await state.mutate(
        projectId,
        (ledger) => {
          if (!canRecord(ledger, issue, record.sha, session)) return false;
          (ledger.acceptances[issue] ??= []).push(record);
          ledger.answeredEvents[eventId] = record.at;
          if (escalation) ledger.escalations.push(escalation);
          return true;
        },
        revision,
      );
      return applied
        ? null
        : { refused: "The acceptance event has changed. Read Factory status again." };
    } catch (error) {
      if (error instanceof RevisionConflictError) return { refused: error.message };
      throw error;
    }
  }

  async function decide(
    issue: number,
    sha: string,
    session: RunnerRef,
    improvements: string[] | null,
    context?: DecisionContext,
  ): Promise<Decision> {
    const eventId = acceptanceEventId(issue, sha);
    const invalid = validateDecision(sha, eventId, context);
    if (invalid) return { refused: invalid };
    if (!(await effects.holdsIntake())) return { refused: "Retry on the intake lane holder." };
    const before = await state.read(projectId);
    const recorded = before.runners[session.agentId];
    if (!recorded || !sameSession(recorded, session)) {
      return { refused: sessionRefusal };
    }
    if (!(await currentCandidate(issue, sha))) {
      return {
        refused: "The pull request must still have passing checks and approval on this head.",
      };
    }

    const history = before.acceptances[issue] ?? [];
    const previousIndex = history.findIndex((record) => record.sha === sha);
    const previous = history[previousIndex];
    const priorHistory = previous ? history.slice(0, previousIndex) : history;
    const round = priorHistory.filter((record) => record.outcome === "sent-back").length + 1;
    const sendBackOutcome = round > 2 ? "escalated" : "sent-back";
    const outcome = improvements === null ? "accepted" : sendBackOutcome;
    if (previous) {
      return replay(before, issue, previous, { outcome, improvements, session, round });
    }

    if (recorded.closedAt !== null || !(await effects.sessionOwnsEvent(session, eventId))) {
      return { refused: sessionRefusal };
    }
    if (!(await effects.holdsIntake())) return { refused: "Retry on the intake lane holder." };
    const at = now().toISOString();
    const record: Acceptance = {
      sha,
      outcome,
      improvements: improvements === null ? [] : [...improvements],
      session: session.agentId,
      source: "local-session",
      at,
    };
    const escalation: Escalation | undefined =
      outcome === "escalated"
        ? {
            id: `acceptance:${eventId}`,
            kind: "escalation",
            question: `How should Factory proceed with issue #${issue} after two send-backs?`,
            why: `The Foreman raised further improvements:\n${record.improvements.join("\n")}`,
            options: ["Keep the issue blocked", "Ask the Builder to revise the plan"],
            recommended: "Keep the issue blocked",
            blocksIssues: [issue],
            eventIds: [eventId],
            openedAt: at,
            answeredAt: null,
            answer: null,
          }
        : undefined;
    const refusal = await persistDecision(
      issue,
      session,
      record,
      escalation,
      context?.expectedRevision ?? before.revision,
    );
    if (refusal) return refusal;

    await publish(issue, record, escalation);
    return decisionResult(outcome, round);
  }

  return {
    async brief(issue, sha) {
      const candidate = await currentCandidate(issue, sha);
      if (!candidate) {
        throw new Error("Read the acceptance brief for the current reviewed pull request head.");
      }
      const ledger = await state.read(projectId);
      const sentBack = (ledger.acceptances[issue] ?? []).filter(
        (record) => record.outcome === "sent-back",
      );
      return {
        ...candidate.brief,
        issue,
        intent: ledger.intent[issue] ?? null,
        rules: await input.intent.rulesFor({
          labels: candidate.labels,
          paths: candidate.brief.diffSummary.files,
        }),
        sendBackRound: sentBack.length,
      };
    },
    async accept(issue, sha, session, context?) {
      const result = await decide(issue, sha, session, null, context);
      if ("round" in result) throw new Error("Expected an acceptance decision.");
      return result;
    },
    async sendBack(issue, sha, improvements, session, context?) {
      if (!improvements.length || improvements.some((line) => !line.trim())) {
        return { refused: "Provide at least one improvement and remove any blank entries." };
      }
      const result = await decide(issue, sha, session, [...improvements], context);
      if ("accepted" in result) throw new Error("Expected a send-back decision.");
      return result;
    },
    async recover(issue) {
      if (!(await effects.holdsIntake())) return;
      const ledger = await state.read(projectId);
      const history = ledger.acceptances[issue] ?? [];
      for (const record of history.filter((entry) => entry.outcome === "escalated")) {
        const eventId = acceptanceEventId(issue, record.sha);
        const escalation = ledger.escalations.find((entry) => entry.eventIds.includes(eventId));
        if (escalation?.answeredAt === null) await publish(issue, record, escalation);
      }
      const candidate = await effects.candidate(issue);
      const record = history.find((entry) => entry.sha === candidate?.sha);
      if (!record) return;
      if (record.outcome !== "escalated") await publish(issue, record, undefined);
    },
  };
}
