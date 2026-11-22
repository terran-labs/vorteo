import type { Logger } from "pino";
import type { SessionHostConnector } from "./connector.js";
import { providerAllowsStop } from "./host.js";
import { DEFAULT_IDLE_RELEASE_MS } from "./settings.js";

/** The slice of a managed agent the release decision reads. */
export interface ReleasableAgent {
  id: string;
  lifecycle: string;
  activeTurnId: string | null;
  pendingPermissions: { size: number };
  updatedAt: Date;
  session: {
    isDurablyHosted?(): boolean;
    /** False, a rejection or a timeout keeps the session: stopping it would lose background work. */
    canStopRuntime?(): Promise<boolean>;
  } | null;
}

export interface IdleReleaseManager {
  listAgents(): ReleasableAgent[];
  /** Requires host-side idle admission; a refusal retains the live registration. */
  closeAgent(agentId: string, options: { onlyIfIdle: boolean }): Promise<void>;
}

export interface IdleReleaseOptions {
  manager: IdleReleaseManager;
  connector: Pick<SessionHostConnector, "upgradePending">;
  logger: Logger;
  /** How long an agent must have been quiet before its hosted session is released. */
  idleMs?: number;
  /** How often to look. */
  intervalMs?: number;
  now?: () => number;
}

/** First wait for an agent whose release made no progress: long enough to stop a per-minute loop. */
export const RELEASE_BACKOFF_MIN_MS = 5 * 60_000;
/** Longest wait, doubling from the minimum, so a returning agent still releases within the hour. */
export const RELEASE_BACKOFF_MAX_MS = 60 * 60_000;

export interface IdleRelease {
  /** One pass: the ids whose sessions were released. Empty when no upgrade is pending. */
  runOnce(): Promise<string[]>;
  stop(): void;
}

/**
 * Picks the hosted agents a pending host upgrade may release: idle or errored, with no turn, no pending
 * permission, and quiet for at least idleMs. A running turn or an unanswered permission is never
 * cut; the host waits for them as it always has. The provider's background work check runs
 * afterwards, in startHostedIdleRelease and again in the host's idle close.
 */
export function selectIdleHostedAgents(
  agents: readonly ReleasableAgent[],
  now: number,
  idleMs: number,
): ReleasableAgent[] {
  return agents.filter(
    (agent) =>
      agent.session?.isDurablyHosted?.() === true &&
      (agent.lifecycle === "idle" || agent.lifecycle === "error") &&
      agent.activeTurnId === null &&
      agent.pendingPermissions.size === 0 &&
      now - agent.updatedAt.getTime() >= idleMs,
  );
}

/**
 * While the session host reports a pending upgrade, releases idle hosted sessions so the host
 * reaches zero sessions and exits for launchd to relaunch it on the installed release. Each
 * released agent closes like an idle agent at startup does and reopens on demand, in the new host.
 * Nothing happens while no upgrade is pending, so warm sessions stay warm. A session whose provider
 * holds background work, such as a background shell or monitor that will wake the agent, is kept
 * and holds the upgrade until that work ends: losing it silently is worse than a later upgrade.
 */
export function startHostedIdleRelease(options: IdleReleaseOptions): IdleRelease {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_RELEASE_MS;
  const now = options.now ?? Date.now;
  let running: Promise<string[]> | null = null;
  // Agents already reported as keeping background work during this pending upgrade, so a watcher
  // that runs for hours logs once instead of every pass.
  const retained = new Set<string>();
  // Agents this release closed, keyed by id, with the activity time they had when released. One
  // that is eligible again without newer activity was reopened by something other than its owner
  // (a queue check, a watcher), so releasing it again makes no progress: it waits, doubling.
  const backoffs = new Map<
    string,
    { activityAt: number; delayMs: number; retryAt: number | null }
  >();

  /** True when this pass should skip the agent; starts or extends its backoff when it returns. */
  function backingOff(agent: ReleasableAgent, at: number): boolean {
    const entry = backoffs.get(agent.id);
    if (!entry) return false;
    if (agent.updatedAt.getTime() > entry.activityAt) {
      backoffs.delete(agent.id);
      if (entry.delayMs > 0)
        options.logger.info({ agentId: agent.id }, "Idle release backoff reset by new activity");
      return false;
    }
    if (entry.retryAt === null) {
      entry.delayMs = entry.delayMs
        ? Math.min(entry.delayMs * 2, RELEASE_BACKOFF_MAX_MS)
        : RELEASE_BACKOFF_MIN_MS;
      entry.retryAt = at + entry.delayMs;
      options.logger.info(
        { agentId: agent.id, delayMs: entry.delayMs },
        "Idle release backing off: the agent reopened without new activity",
      );
      return true;
    }
    return at < entry.retryAt;
  }

  function recordAttempt(agent: ReleasableAgent): void {
    const entry = backoffs.get(agent.id);
    backoffs.set(agent.id, {
      activityAt: agent.updatedAt.getTime(),
      delayMs: entry?.delayMs ?? 0,
      retryAt: null,
    });
  }

  async function runOnce(): Promise<string[]> {
    if (!(await options.connector.upgradePending?.())) {
      retained.clear();
      // Backoffs belong to one pending upgrade; the next upgrade releases every agent afresh.
      backoffs.clear();
      return [];
    }
    const released: string[] = [];
    const at = now();
    for (const agent of selectIdleHostedAgents(options.manager.listAgents(), at, idleMs)) {
      if (backingOff(agent, at)) continue;
      // Expected while a background shell, monitor or subagent runs, so it is not a warning.
      // The host repeats this check before it admits the close; checking here first keeps the
      // refusal quiet.
      // A host that predates the check leaves the host's own idle admission as the only guard.
      if (!(await providerAllowsStop(agent.session?.canStopRuntime?.bind(agent.session)))) {
        if (!retained.has(agent.id))
          options.logger.info(
            { agentId: agent.id },
            "Kept an idle hosted session for its background work; the host upgrade waits for it",
          );
        retained.add(agent.id);
        continue;
      }
      retained.delete(agent.id);
      // A failed close, such as a stale provider session, backs off the same way as a reopen.
      recordAttempt(agent);
      try {
        await options.manager.closeAgent(agent.id, { onlyIfIdle: true });
        released.push(agent.id);
      } catch (error) {
        options.logger.warn(
          { err: error, agentId: agent.id },
          "Could not release an idle hosted session for the host upgrade",
        );
      }
    }
    if (released.length)
      options.logger.info(
        { count: released.length },
        "Released idle hosted sessions so the session host can exit for its upgrade",
      );
    return released;
  }

  const timer =
    options.intervalMs === undefined || options.intervalMs <= 0
      ? null
      : setInterval(() => {
          if (running) return;
          running = runOnce()
            .catch((error: unknown) => {
              options.logger.warn({ err: error }, "Idle hosted session release failed");
              return [];
            })
            .finally(() => {
              running = null;
            });
        }, options.intervalMs);
  timer?.unref();

  return {
    runOnce,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
