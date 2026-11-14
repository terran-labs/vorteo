import type { Logger } from "pino";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent-loading.js";
import type { AgentUsage } from "../agent-sdk-types.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  blockedReviewDue,
  blockedReviewsUsed,
  onlyInProgressWork,
  reviewFingerprint,
  BLOCKED_REVIEW_DAILY_THREAD_CAP,
  BLOCKED_REVIEW_DELAYS_MS,
  BLOCKED_REVIEW_HOURLY_INSTALLATION_CAP,
} from "./blocked-review.js";

/** A burst of stopped threads is reviewed a few at a time, so none waits past its slot. */
const CONCURRENT_REVIEWS = 3;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

interface ReviewServiceOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  /** Host setting; reviews are opt-in because each one resumes a whole provider session. */
  enabled: () => boolean;
  now?: () => number;
}

/** One daemon-owned timer reviews existing threads; it never creates a thread or schedule. */
export class BlockedTaskReviewService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private readonly attempts = new Map<string, number>();
  // Start times of reviews that reached a provider. In memory: a daemon restart resets the caps,
  // which only ever allows a few more reviews, and the ladder itself is stored.
  private readonly started = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: ReviewServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Blocked-task review scan failed");
      });
    }, 60_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped || !this.options.enabled()) return;
    if (this.options.agentManager.isRestartDraining()) return;
    this.running = true;
    try {
      const records = await this.options.agentStorage.list();
      // A running subagent reports back when it finishes, so its parent needs no review yet.
      const awaitingChild = new Set(
        records
          .filter((record) => record.lastStatus === "running" && !record.archivedAt)
          .map((record) => record.labels[PARENT_AGENT_ID_LABEL])
          .filter((parent): parent is string => Boolean(parent)),
      );
      // Prompting an account that is known to be limited only produces another limit stop.
      const limited = new Map<string, boolean>();
      const due: StoredAgentRecord[] = [];
      for (const record of records) {
        if (
          this.stopped ||
          !this.options.enabled() ||
          this.options.agentManager.isRestartDraining()
        )
          return;
        const now = this.now();
        const attempted = this.attempts.get(record.id);
        const recentlyAttempted =
          attempted !== undefined && now - attempted < BLOCKED_REVIEW_DELAYS_MS[0]!;
        if (recentlyAttempted || !blockedReviewDue(record, now)) continue;
        if (this.capReached(record.id, now)) {
          // Recheck after the usual retry gap instead of logging the skip every scan.
          this.attempts.set(record.id, now);
          continue;
        }
        if (!limited.has(record.provider))
          limited.set(
            record.provider,
            (await this.options.agentManager.usageLimitedUntil(record.provider)) !== null,
          );
        if (limited.get(record.provider)) continue;
        this.attempts.set(record.id, now);
        // Counted when scheduled, so reviews started together cannot exceed a cap.
        this.started.set(record.id, [...(this.started.get(record.id) ?? []), now]);
        due.push(record);
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENT_REVIEWS, due.length) }, async () => {
          for (let record = due.shift(); record; record = due.shift())
            await this.review(record, awaitingChild.has(record.id));
        }),
      );
    } finally {
      this.running = false;
    }
  }

  /** Drops expired entries, then reports whether this thread or the installation is at its cap. */
  private capReached(agentId: string, now: number): boolean {
    let lastHour = 0;
    for (const [id, times] of this.started) {
      const kept = times.filter((time) => now - time < DAY_MS);
      if (kept.length) this.started.set(id, kept);
      else this.started.delete(id);
      lastHour += kept.filter((time) => now - time < HOUR_MS).length;
    }
    const reached =
      lastHour >= BLOCKED_REVIEW_HOURLY_INSTALLATION_CAP ||
      (this.started.get(agentId)?.length ?? 0) >= BLOCKED_REVIEW_DAILY_THREAD_CAP;
    if (reached)
      this.options.logger.info({ agentId, lastHour }, "Blocked-work review skipped at its cap");
    return reached;
  }

  /** A scheduled review that never reached the provider gives its cap slot back. */
  private release(agentId: string, at: number): void {
    const times = this.started.get(agentId) ?? [];
    const index = times.indexOf(at);
    if (index >= 0) times.splice(index, 1);
  }

  private async review(record: StoredAgentRecord, awaitingChild: boolean): Promise<void> {
    const agentId = record.id;
    const scheduledAt = this.started.get(agentId)?.at(-1) ?? this.now();
    try {
      // In-progress work with a live watcher or a running subagent wakes itself. Only a runtime
      // that was already loaded can hold a watcher; one resumed for this review starts empty.
      const wasLoaded = Boolean(this.options.agentManager.getAgent(agentId));
      await ensureUnarchivedAgentLoaded(agentId, this.options);
      const selfWaking =
        onlyInProgressWork(record) &&
        (awaitingChild ||
          (wasLoaded && (await this.options.agentManager.hasLiveBackgroundWork(agentId))));
      const before = selfWaking ? null : await this.options.agentStorage.get(agentId);
      const stream = before
        ? await this.options.agentManager.startBlockedTaskReview(agentId, () => !this.stopped)
        : null;
      if (!stream || !before) {
        this.release(agentId, scheduledAt);
        return;
      }
      const startedAt = this.now();
      const usage: AgentUsage = {};
      for await (const event of stream) {
        // AgentManager owns timeline delivery, usage accounting and lifecycle updates.
        if (event.type === "turn_completed" || event.type === "usage_updated")
          Object.assign(usage, event.usage);
      }
      const after = await this.options.agentStorage.get(agentId);
      // A watcher the review just started is progress: the thread can now wake itself.
      const unchanged =
        (!after || reviewFingerprint(after) === reviewFingerprint(before)) &&
        !(await this.options.agentManager.hasLiveBackgroundWork(agentId));
      if (unchanged) await this.options.agentStorage.spendBlockedReviewLadder(agentId);
      const cost = (snapshot: StoredAgentRecord | null) =>
        snapshot?.lastUsage?.totalCostUsd ?? snapshot?.lastUsage?.estimatedCostUsd;
      const costBefore = cost(before);
      const costAfter = cost(after);
      // One line per review makes its cost and yield measurable from the daemon log alone.
      // Providers do not report cache writes here; the session cost difference includes them.
      this.options.logger.info(
        {
          agentId,
          provider: before.provider,
          model: before.config?.model,
          review: blockedReviewsUsed(before) + 1,
          changed: !unchanged,
          durationMs: this.now() - startedAt,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          contextTokens: usage.contextWindowUsedTokens,
          costUsd:
            costBefore !== undefined && costAfter !== undefined
              ? Number((costAfter - costBefore).toFixed(4))
              : undefined,
        },
        "Blocked-work review finished",
      );
    } catch (error) {
      // Failed preparation or inference must not retry every scheduler tick.
      this.options.logger.warn({ err: error, agentId }, "Blocked-work review could not complete");
    }
  }
}
