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
  pausedFactoryProjects: () => Promise<ReadonlySet<string>>;
  now?: () => number;
}

interface RetainedObservation {
  agentId: string;
  cwd: string;
  generation: ChecklistWakeGeneration;
  subscription: Awaited<ReturnType<ChecklistGithubObservationPort["subscribe"]>>;
}

/** Monitoring costs no model tokens. Only shared admission can reserve an existing thread turn. */
export class ChecklistWakeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private scanning = false;
  private readonly waking = new Set<string>();
  private readonly retained = new Map<string, RetainedObservation>();
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
          if (await this.satisfied(record, generation)) satisfied.push(generation);
        }
        if (satisfied.length && this.canContinue()) await this.wake(record, satisfied);
      }
    } finally {
      this.prune();
      if (!this.canContinue()) this.releaseAll();
      this.scanning = false;
    }
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
  }

  private async satisfied(
    record: StoredAgentRecord,
    generation: ChecklistWakeGeneration,
  ): Promise<boolean> {
    const condition = generation.condition;
    if (condition.kind === "deadline") return Date.parse(condition.at) <= this.now();
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
        retained = { agentId: record.id, cwd: record.cwd, generation, subscription };
        this.retained.set(generation.generation, retained);
      }
      return retained.subscription.read() === "satisfied";
    } catch (error) {
      this.options.logger.warn(
        { err: error, agentId: record.id },
        "Checklist GitHub observation unavailable",
      );
      return false;
    }
  }

  /** Children inherit Factory pause suppression from their recorded parent chain. */
  private async factoryAllows(record: StoredAgentRecord): Promise<boolean> {
    const projects = new Set<string>();
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
      return false;
    }
    if (!projects.size) return true;
    try {
      const paused = await this.options.pausedFactoryProjects();
      return ![...projects].some((project) => paused.has(project));
    } catch {
      await this.suppress(record, authority, "Local Factory pause authority unavailable");
      return false;
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
    const canContinue = () =>
      this.canContinue() && this.options.agentStorage.getLoadedRecord(agentId)?.cwd === record.cwd;
    this.waking.add(agentId);
    let draining = false;
    try {
      if (!canContinue()) return;
      await ensureUnarchivedAgentLoaded(agentId, this.options);
      if (!canContinue() || !(await this.factoryAllows(record))) return;
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
      if (!draining) this.waking.delete(agentId);
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
