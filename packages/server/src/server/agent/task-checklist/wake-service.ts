import type { Logger } from "pino";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ChecklistWakeCondition } from "@getpaseo/protocol/task-checklist";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage, ChecklistWakeGeneration, StoredAgentRecord } from "../agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent-loading.js";
import { PROJECT_FACTORY_ROLE_LABEL } from "../../factory/project/roles.js";
import { factoryProjectOf } from "./blocked-review.js";

export type ChecklistGithubCondition = Exclude<ChecklistWakeCondition, { kind: "deadline" }>;

/** The shared GitHub adapter owns authentication, target semantics, polling and host budgets. */
export interface ChecklistGithubObservationPort {
  subscribe(input: { cwd: string; condition: ChecklistGithubCondition }): Promise<{
    /** Missing, stale or failed observations remain unresolved. */
    read(): "satisfied" | "unresolved";
    availability(): { available: boolean; reason?: string };
    isCurrentSource(): Promise<boolean>;
    release(): void;
  }>;
}

interface WakeServiceOptions {
  agentManager: AgentManager;
  serverId: string;
  agentStorage: AgentStorage;
  logger: Logger;
  github: ChecklistGithubObservationPort;
  /** True only when all accepted condition kinds and their runtime dependencies are installed. */
  ready: () => boolean;
  captureFactoryAuthority: () => Promise<{
    read(projectId: string): "running" | "paused" | "draining" | "unavailable";
  }>;
  now?: () => number;
}

interface RetainedObservation {
  agentId: string;
  cwd: string;
  generation: ChecklistWakeGeneration;
  sourceCheckedUntil: number;
  subscription: Awaited<ReturnType<ChecklistGithubObservationPort["subscribe"]>>;
}

/** Monitoring costs no model tokens. Only shared admission can reserve an existing thread turn. */
export class ChecklistWakeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private scanning = false;
  private readonly waking = new Set<string>();
  private readonly retained = new Map<string, RetainedObservation>();
  private readonly retryAfter = new Map<string, number>();
  private readonly refusedUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: WakeServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Checklist condition scan failed");
      });
    }, 15_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseAll();
  }

  /** Live, source-bound availability; a subscription alone is not an observation. */
  isMonitoring(record: StoredAgentRecord, generation: ChecklistWakeGeneration): boolean {
    if (!this.canContinue()) return false;
    const current = this.options.agentStorage.getLoadedRecord(record.id);
    if (
      !current ||
      current.cwd !== record.cwd ||
      !this.options.agentStorage.currentChecklistWakeGenerations(record.id, [generation]).length
    )
      return false;
    if (generation.condition.kind === "deadline") return true;
    const retained = this.retained.get(generation.generation);
    return (
      retained?.cwd === record.cwd &&
      retained.sourceCheckedUntil > this.now() &&
      retained.subscription.availability().available === true
    );
  }

  private canContinue(): boolean {
    return !this.stopped && this.options.ready() && !this.options.agentManager.isRestartDraining();
  }

  async tick(): Promise<void> {
    if (this.scanning) return;
    if (!this.canContinue()) {
      this.releaseAll();
      return;
    }
    this.scanning = true;
    try {
      const records = await this.options.agentStorage.list();
      this.prune();
      this.pruneRetryDelays(records);
      for (const record of records) {
        if (!this.canContinue()) break;
        if (!this.active(record) || this.waking.has(record.id)) continue;
        const observed = this.options.agentStorage.currentChecklistWakeGenerations(
          record.id,
          record.checklistWakeGenerations ?? [],
        );
        if (!observed.length || !(await this.factoryAllows(record))) continue;
        const satisfied: ChecklistWakeGeneration[] = [];
        for (const generation of observed) {
          if (!this.canContinue()) break;
          if (
            (await this.satisfied(record, generation)) &&
            (this.refusedUntil.get(generation.generation) ?? 0) <= this.now()
          )
            satisfied.push(generation);
        }
        if (satisfied.length && this.canContinue()) await this.wake(record, satisfied);
      }
    } finally {
      this.prune();
      if (!this.canContinue()) this.releaseAll();
      this.scanning = false;
    }
  }

  private pruneRetryDelays(records: StoredAgentRecord[]): void {
    const generations = new Set(
      records.flatMap((record) =>
        (record.checklistWakeGenerations ?? []).map((entry) => entry.generation),
      ),
    );
    for (const retries of [this.retryAfter, this.refusedUntil])
      for (const id of retries.keys()) if (!generations.has(id)) retries.delete(id);
  }

  private active(record: StoredAgentRecord): boolean {
    return (
      !record.archivedAt &&
      !record.internal &&
      !record.owner &&
      !record.config?.controllerExecutionId &&
      !!record.persistence?.sessionId
    );
  }

  private prune(): void {
    for (const [id, retained] of this.retained) {
      const record = this.options.agentStorage.getLoadedRecord(retained.agentId);
      if (
        record &&
        this.active(record) &&
        record.cwd === retained.cwd &&
        this.options.agentStorage.currentChecklistWakeGenerations(retained.agentId, [
          retained.generation,
        ]).length
      )
        continue;
      retained.subscription.release();
      this.retained.delete(id);
    }
  }

  private releaseAll(): void {
    for (const retained of this.retained.values()) retained.subscription.release();
    this.retained.clear();
    this.retryAfter.clear();
    this.refusedUntil.clear();
  }

  private async satisfied(
    record: StoredAgentRecord,
    generation: ChecklistWakeGeneration,
  ): Promise<boolean> {
    const condition = generation.condition;
    if (condition.kind === "deadline") return Date.parse(condition.at) <= this.now();
    if ((this.retryAfter.get(generation.generation) ?? 0) > this.now()) return false;
    try {
      let retained = this.retained.get(generation.generation);
      if (!retained) {
        const subscription = await this.options.github.subscribe({ cwd: record.cwd, condition });
        if (
          !this.canContinue() ||
          this.options.agentStorage.getLoadedRecord(record.id)?.cwd !== record.cwd ||
          !this.options.agentStorage.currentChecklistWakeGenerations(record.id, [generation]).length
        ) {
          subscription.release();
          return false;
        }
        retained = {
          agentId: record.id,
          cwd: record.cwd,
          generation,
          subscription,
          sourceCheckedUntil: this.now() + 120_000,
        };
        this.retained.set(generation.generation, retained);
        this.retryAfter.delete(generation.generation);
      }
      // Refresh two scan intervals early, including while admission is backed off.
      // Failure releases the observation immediately; a stalled refresh still expires.
      if (retained.sourceCheckedUntil <= this.now() + 30_000) {
        if (!(await retained.subscription.isCurrentSource()))
          throw new Error("GitHub workspace source changed");
        retained.sourceCheckedUntil = this.now() + 120_000;
      }
      const availability = retained.subscription.availability();
      if (!availability.available && availability.reason)
        await this.recordUnavailable(record, generation, availability.reason);
      return retained.subscription.read() === "satisfied";
    } catch {
      this.retained.get(generation.generation)?.subscription.release();
      this.retained.delete(generation.generation);
      this.retryAfter.set(generation.generation, this.now() + 120_000);
      await this.recordUnavailable(
        record,
        generation,
        "GitHub observer unavailable for this workspace",
      );
      return false;
    }
  }

  private async recordUnavailable(
    record: StoredAgentRecord,
    generation: ChecklistWakeGeneration,
    reason: string,
  ): Promise<void> {
    if (
      await this.options.agentStorage.recordChecklistWakeUnavailable(record.id, generation, {
        reason,
        at: new Date(this.now()).toISOString(),
        cwd: record.cwd,
      })
    )
      this.options.logger.info(
        {
          agentId: record.id,
          taskId: generation.taskId,
          generation: generation.generation,
          cwd: record.cwd,
          reason,
        },
        "Checklist monitoring unavailable; ordinary opted-in review eligibility applies",
      );
  }

  /** Children inherit Factory pause suppression from their recorded parent chain. */
  private async factoryAllows(record: StoredAgentRecord): Promise<(() => boolean) | null> {
    const projects = new Set<string>();
    const identities = new Map<string, string>();
    const identity = (id: string) => {
      const stored = this.options.agentStorage.getLoadedRecord(id);
      return JSON.stringify(
        stored ? [stored.archivedAt, Object.entries(stored.labels).sort()] : null,
      );
    };
    const unchanged = () => [...identities].every(([id, value]) => identity(id) === value);
    const visited = new Set<string>();
    let factoryOwned = false;
    let unresolved = false;
    let authority = { serverId: this.options.serverId, agentId: record.id };
    let reason = "Factory project authority unavailable";
    let current: StoredAgentRecord | null | undefined = this.options.agentStorage.getLoadedRecord(
      record.id,
    );
    while (current) {
      if (visited.has(current.id)) {
        unresolved = true;
        reason = "Cyclic Factory parent authority";
        break;
      }
      identities.set(current.id, identity(current.id));
      visited.add(current.id);
      const project = factoryProjectOf(current);
      if (project) projects.add(project);
      factoryOwned ||=
        !!current.labels[PROJECT_FACTORY_ROLE_LABEL] ||
        !!current.labels["factory.role"] ||
        !!current.labels["factory.issue"] ||
        !!current.labels["factory.installation"];
      const parent: ReturnType<typeof getParentAddressFromLabels> = getParentAddressFromLabels(
        current.labels,
        this.options.serverId,
      );
      if (!parent) break;
      authority = parent;
      if (parent.serverId !== this.options.serverId) {
        unresolved = true;
        reason = "Remote Factory parent authority unavailable";
        break;
      }
      identities.set(parent.agentId, identity(parent.agentId));
      current = this.options.agentStorage.getLoadedRecord(parent.agentId);
      if (!current) {
        unresolved = true;
        reason = "Missing Factory parent authority";
      }
    }
    // Remote ancestry needs an authoritative pause reader before Factory work can wake.
    // An ordinary thread with a missing parent does not acquire a new hold.
    if (factoryOwned && (unresolved || !projects.size)) {
      await this.suppress(record, authority, reason);
      return null;
    }
    if (!projects.size) return unchanged() ? unchanged : null;
    try {
      const snapshot = await this.options.captureFactoryAuthority();
      if ([...projects].some((project) => snapshot.read(project) === "unavailable")) {
        await this.suppress(record, authority, "Local Factory pause authority unavailable");
        return null;
      }
      const allowed = () =>
        unchanged() && [...projects].every((project) => snapshot.read(project) === "running");
      return allowed() ? allowed : null;
    } catch {
      await this.suppress(record, authority, "Local Factory pause authority unavailable");
      return null;
    }
  }

  private async suppress(
    record: StoredAgentRecord,
    authority: { serverId: string; agentId: string },
    reason: string,
  ): Promise<void> {
    const recorded = await this.options.agentStorage.recordChecklistWakeSuppression(
      record.id,
      record.checklistWakeGenerations ?? [],
      { ...authority, reason, at: new Date(this.now()).toISOString() },
    );
    for (const entry of recorded) {
      this.options.logger.info(
        {
          agentId: record.id,
          taskId: entry.taskId,
          generation: entry.generation,
          suppression: entry.suppression,
        },
        "Checklist condition wake suppressed by unresolved Factory authority",
      );
    }
  }

  private async wake(
    record: StoredAgentRecord,
    observed: ChecklistWakeGeneration[],
  ): Promise<void> {
    const agentId = record.id;
    let factoryAllows: (() => boolean) | null = null;
    const canContinue = () =>
      !!factoryAllows?.() &&
      this.canContinue() &&
      this.options.agentStorage.getLoadedRecord(agentId)?.cwd === record.cwd &&
      observed.every(
        (entry) =>
          entry.condition.kind === "deadline" ||
          ((this.retained.get(entry.generation)?.sourceCheckedUntil ?? 0) > this.now() &&
            this.retained.get(entry.generation)?.subscription.read() === "satisfied"),
      );
    this.waking.add(agentId);
    let draining = false;
    try {
      if (!this.canContinue()) return;
      factoryAllows = await this.factoryAllows(record);
      if (
        !(await this.options.agentManager.canPrepareChecklistConditionWake(
          agentId,
          observed,
          canContinue,
        ))
      )
        return;
      await ensureUnarchivedAgentLoaded(agentId, this.options);
      factoryAllows = await this.factoryAllows(record);
      if (!canContinue()) return;
      const stream = await this.options.agentManager.startChecklistConditionWake(
        agentId,
        observed,
        canContinue,
      );
      if (!stream) return;
      draining = true;
      // Keep scanning other threads while this admitted turn runs. Stop never cancels its work.
      void this.drain(agentId, stream);
    } catch (error) {
      this.options.logger.warn({ err: error, agentId }, "Checklist condition wake refused");
    } finally {
      if (!draining) {
        this.waking.delete(agentId);
        for (const entry of this.options.agentStorage.currentChecklistWakeGenerations(
          agentId,
          observed,
        ))
          this.refusedUntil.set(entry.generation, this.now() + 120_000);
      }
    }
  }

  private async drain(agentId: string, stream: AsyncGenerator<unknown>): Promise<void> {
    try {
      for await (const event of stream) void event;
    } catch (error) {
      this.options.logger.warn({ err: error, agentId }, "Checklist condition turn failed");
    } finally {
      this.waking.delete(agentId);
    }
  }
}
