import type { Logger } from "pino";
import type { AppliedSeqStore } from "./applied-store.js";
import { SessionHostClientError, type HostedSession, type SessionHostClient } from "./client.js";
import { providerAllowsStop } from "./host.js";
import type { HostedAdoption, HostedSessionRouting } from "./hosted-agent-client.js";
import type { HostedAgentSession } from "./hosted-agent-session.js";
import { HostedSessionSnapshotSchema } from "./session-contract.js";

/** The part of agent storage startup needs: whether an agent still exists and is active. */
export interface StoredAgentLookup {
  get(agentId: string): Promise<{ archivedAt?: string | null } | null>;
}

export interface HostedStartupPlan {
  /**
   * Running hosted sessions, and idle ones whose provider holds background work, attached and
   * registered for adoption.
   */
  adopted: string[];
  /** Idle or orphaned hosted sessions closed; their agents resume on demand as usual. */
  closed: string[];
  /** Agents this worker's predecessor hosted whose sessions no longer exist. */
  lost: string[];
  /** False when no host answered, so nothing could be decided. */
  hostReachable: boolean;
}

interface StartupRouting extends HostedSessionRouting {
  applied: AppliedSeqStore;
  adoptions: Map<string, HostedAdoption>;
}

async function closeHosted(client: SessionHostClient, sessionId: string): Promise<void> {
  const channel = await client.attach({ sessionId, afterSeq: null });
  await channel.call({ method: "close" });
}

/** Idle sessions checked at once at startup, and the bound on their background work checks. */
const STARTUP_CHECK_CONCURRENCY = 8;
const STARTUP_CHECK_DEADLINE_MS = 20_000;

/**
 * Whether an idle session's provider still holds background work, such as a background shell or
 * monitor that will wake the agent, which closing it would silently end. Asked only of a host
 * that advertises the check; an older host's sessions close as before. A check that fails or
 * times out keeps the session, and so does one still unanswered when the startup deadline passes.
 */
async function holdsBackgroundWork(
  channel: HostedSession,
  capabilities: Record<string, unknown> | undefined,
  deadline: Promise<"deadline">,
): Promise<"yes" | "no" | "deadline"> {
  if (capabilities?.runtimeStopCheck !== true) return "no";
  const allowed = providerAllowsStop(
    async () => (await channel.call({ method: "canStopRuntime" })) === true,
  );
  const answer = await Promise.race([allowed, deadline]);
  if (answer === "deadline") return "deadline";
  return answer ? "no" : "yes";
}

/** Attaches after the last applied event; a stale or missing record rebuilds from what is left. */
async function attachRunning(
  client: SessionHostClient,
  sessionId: string,
  afterSeq: number,
): Promise<{ channel: HostedSession; throughSeq: number; lossy: boolean }> {
  try {
    const channel = await client.attach({ sessionId, afterSeq });
    return { channel, throughSeq: afterSeq, lossy: false };
  } catch (error) {
    if (!(error instanceof SessionHostClientError) || error.code !== "replay_unavailable")
      throw error;
  }
  const channel = await client.attach({ sessionId, afterSeq: null });
  return { channel, throughSeq: channel.attach.lastSeq, lossy: true };
}

/**
 * First half of startup, before the worker accepts clients: attach every hosted session that is
 * still running a turn, waiting on a permission, or holding events no worker applied yet, and
 * register it for adoption, so whoever loads the agent first adopts it rather than starting a
 * second provider. An idle session whose provider holds background work is adopted the same way.
 * Other idle sessions are closed and resume on demand like any other agent, which also keeps the
 * host from accumulating them.
 */
export async function planHostedStartup(input: {
  routing: StartupRouting;
  agents: StoredAgentLookup;
  logger: Logger;
  /** Overrides for tests: checks run at once and the deadline for all of them. */
  checks?: { concurrency?: number; deadlineMs?: number };
}): Promise<HostedStartupPlan> {
  const { routing, logger } = input;
  const records = await routing.applied.list();
  const plan: HostedStartupPlan = { adopted: [], closed: [], lost: [], hostReachable: false };
  // A session's first record follows its first event, so a worker that died sooner left none.
  // With the setting off, such a session is still found as long as a host socket exists.
  if (records.size === 0 && !routing.isEnabled() && !(await routing.connector.present()))
    return plan;
  const client = await routing.connector.connect({ force: true });
  if (!client) {
    // Startup does not wait for a host that is alive but slow: its sessions may still run, and
    // loading each agent takes it over then. Only a host that is gone took its sessions along.
    if ((await routing.connector.hostState()) === "gone") plan.lost = [...records.keys()];
    return plan;
  }
  plan.hostReachable = true;
  const connected: SessionHostClient = client;
  const summaries = await connected.list();
  const listed = new Set(summaries.map((summary) => summary.sessionId));
  // The pass runs before the worker accepts clients, so slow background work checks must not hold
  // startup: they run a few at a time, and any still unanswered at the deadline keep their
  // sessions. The deadline bounds only those checks, not listing, attaching or closing.
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve("deadline"),
      input.checks?.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS,
    );
    deadlineTimer.unref();
  });
  type Outcome = "closed" | "adopted" | "background" | "deadline" | null;

  async function decide(summary: (typeof summaries)[number]): Promise<Outcome> {
    const agentId = summary.sessionId;
    try {
      const stored = await input.agents.get(agentId);
      const snapshot = HostedSessionSnapshotSchema.safeParse(summary.snapshot);
      const running =
        !snapshot.success ||
        snapshot.data.activeTurnId !== null ||
        snapshot.data.pendingPermissions.length > 0;
      const record = records.get(agentId);
      const afterSeq = record && record.hostId === connected.host.id ? record.lastAppliedSeq : 0;
      // A turn that finished while no worker was attached, as during a long Host update, left
      // events no worker applied: the end of its output. Closing it here would lose them, so such
      // a session is adopted like a running one; the agent loads, applies them, and stays hosted
      // and idle as if the turn had ended under this worker.
      const unapplied = summary.lastSeq > afterSeq;
      if (!stored || stored.archivedAt) {
        await closeHosted(connected, agentId);
        await routing.applied.remove(agentId);
        return "closed";
      }
      const attached = await attachRunning(connected, agentId, afterSeq);
      let outcome: Outcome = "adopted";
      // An idle session whose watcher is still alive is adopted without a prompt: the provider
      // survived this daemon restart, and its watcher will wake the agent.
      if (!running && !unapplied) {
        const holds = await holdsBackgroundWork(
          attached.channel,
          snapshot.success ? snapshot.data.capabilities : undefined,
          deadline,
        );
        if (holds === "no") {
          await attached.channel.call({ method: "close" });
          await routing.applied.remove(agentId);
          return "closed";
        }
        outcome = holds === "yes" ? "background" : "deadline";
      }
      routing.adoptions.set(agentId, { ...attached, hostId: connected.host.id });
      return outcome;
    } catch (error) {
      logger.warn({ err: error, agentId }, "Could not take over a hosted session at startup");
      return null;
    }
  }

  const outcomes: Outcome[] = Array.from({ length: summaries.length }, () => null);
  let next = 0;
  const concurrency = Math.max(1, input.checks?.concurrency ?? STARTUP_CHECK_CONCURRENCY);
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, summaries.length) }, async () => {
        while (next < summaries.length) {
          const index = next++;
          outcomes[index] = await decide(summaries[index]!);
        }
      }),
    );
  } finally {
    clearTimeout(deadlineTimer);
  }
  // Listing order, so the plan does not depend on which check answered first.
  summaries.forEach((summary, index) => {
    const outcome = outcomes[index];
    if (outcome === "closed") plan.closed.push(summary.sessionId);
    else if (outcome !== null) plan.adopted.push(summary.sessionId);
  });
  const count = (kind: Outcome) => outcomes.filter((outcome) => outcome === kind).length;
  if (summaries.length > 0)
    logger.info(
      {
        closed: count("closed"),
        adoptedForBackgroundWork: count("background"),
        adoptedAtDeadline: count("deadline"),
        adopted: count("adopted"),
      },
      "Planned hosted sessions at startup",
    );
  for (const agentId of records.keys()) {
    if (listed.has(agentId)) continue;
    await routing.applied.remove(agentId);
    plan.lost.push(agentId);
  }
  return plan;
}

/** The agent no longer exists or names a provider this worker cannot run. */
function isDefinitiveLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /^Agent not found:|references unavailable provider|^Agent is archived:/.test(message);
}

/**
 * Second half, once the worker accepts clients: load each adopted agent, which rebuilds its
 * timeline from the host and then lets its held live events through. Loading also happens on
 * demand if a client gets there first.
 */
export async function loadAdoptedAgents(input: {
  routing: StartupRouting;
  adopted: readonly string[];
  loadAgent(agentId: string): Promise<unknown>;
  logger: Logger;
}): Promise<{ attached: number; total: number }> {
  let attached = 0;
  for (const agentId of input.adopted) {
    let adoptedSession: HostedAgentSession | null = null;
    const adoption = input.routing.adoptions.get(agentId);
    if (adoption) {
      const previous = adoption.onAdopted;
      adoption.onAdopted = (session) => {
        adoptedSession = session;
        previous?.(session);
      };
    }
    let failure: unknown = null;
    try {
      await input.loadAgent(agentId);
      attached += 1;
    } catch (error) {
      failure = error;
      input.logger.warn({ err: error, agentId }, "Could not load an adopted hosted agent");
    } finally {
      // Loading normally releases held events after the rebuilt history; never leave them held.
      (adoptedSession as HostedAgentSession | null)?.releaseLive();
      const unused = input.routing.adoptions.get(agentId);
      if (unused) {
        input.routing.adoptions.delete(agentId);
        if (failure !== null && isDefinitiveLoadFailure(failure)) {
          // Nobody can ever drive this session again, so stop its provider.
          await unused.channel.call({ method: "close" }).catch(() => {});
          await input.routing.applied.remove(agentId).catch(() => {});
        } else {
          // A transient failure: keep the turn running. A later load takes the session over.
          unused.channel.release();
          input.logger.warn({ agentId }, "Left a hosted session running for a later load");
        }
      }
    }
  }
  return { attached, total: input.adopted.length };
}
