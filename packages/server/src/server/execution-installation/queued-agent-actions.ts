import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  QueuedAgentActionSchema,
  type QueuedAgentAction,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomicSync } from "../private-files.js";
import {
  delegableUnderGrant,
  delegatedAdmissionStep,
  delegatedApproval,
  delegatedDispatchHolds,
  delegatedPlanDigest,
  type DelegationGrant,
} from "./delegated-admission.js";
import { RestartRequestError } from "./restarts.js";

/**
 * One reviewed installation change a Host agent may request, such as renaming the installation.
 * Each definition is fixed code that calls exactly one existing owner operation; there is no
 * route or handler parameter, so the queue never proxies anything else. The front-door test pins
 * each definition to the owner route it stands for.
 */
export interface QueuedActionDefinition {
  /** The action id an agent names with `request-installation-change --action`, such as "installation-name". */
  name: string;
  /** The exact request the action accepts. */
  schema: z.ZodType<unknown>;
  /** What the owner should expect when it runs, shown in Installation controls. */
  disruption(request: unknown): string;
  /** Validates the target before anything changes; throws with the first real error. */
  preflight?(request: unknown): Promise<void>;
  /** The current value `restore` puts back, recorded before any effect. */
  capture(): Promise<unknown>;
  /** Applies the change and describes the result. */
  apply(request: unknown): Promise<string>;
  /**
   * For a change that completes after a coordinator restart: false while it is still settling.
   * Absent means the change is complete when `apply` returns.
   */
  settled?(): Promise<boolean>;
  /**
   * Whether the requested state is in effect now, the revision of that state for a
   * compare-and-set restore, and a description of the current value.
   */
  state(request: unknown): Promise<{
    applied: boolean;
    revision: string;
    detail: string;
    /** The id of the operation that last changed the value, where the owner operation records one. */
    operation?: string;
  }>;
  /** For changes that can interrupt remote access: null when both addresses answer, else evidence. */
  reachable?(request: unknown): Promise<string | null>;
  /**
   * Puts `previous` back only if the state is still at `revision`; refuses otherwise. `operation`
   * names the change where the owner operation records one, so recovery can recognize it.
   */
  restore?(previous: unknown, revision: string, operation: string): Promise<void>;
}

const JournalSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.array(QueuedAgentActionSchema),
});

/** Restores started for one request at most; a failing restore must not loop restarts. */
const RESTORE_ATTEMPTS = 2;

/** How long a finished request stays in Installation controls. */
const RETAINED = 20;

export interface QueuedAgentActions {
  list(): QueuedAgentAction[];
  get(id: string): QueuedAgentAction | null;
  request(name: string, body: unknown, requester: string | undefined): QueuedAgentAction;
  /** The owner's decision, or management cancellation. */
  decide(id: string, revision: string, decision: "approve" | "cancel"): QueuedAgentAction;
  /** Admits, dispatches and follows requests. Safe to call repeatedly. */
  drain(): Promise<void>;
}

export function createQueuedAgentActions(input: {
  stateDir: string;
  definitions: readonly QueuedActionDefinition[];
  grant: () => DelegationGrant | null;
  /** Another coordinator restart or installation change in progress; refuses dispatch. */
  conflict?: () => string | null;
  now?: () => Date;
  cancellationDelayMs?: number;
}): QueuedAgentActions {
  const file = path.join(input.stateDir, "queued-agent-actions", "jobs.json");
  const now = input.now ?? (() => new Date());
  const delayMs = input.cancellationDelayMs ?? 30_000;
  const definition = (name: string) => {
    const found = input.definitions.find((item) => item.name === name);
    if (!found) throw new RestartRequestError(`Unknown installation change ${name}`);
    return found;
  };
  const operation = (job: QueuedAgentAction) => `queued:${job.action}`;
  const plan = (job: QueuedAgentAction) =>
    delegatedPlanDigest(operation(job), { request: job.request });

  const read = (): QueuedAgentAction[] => {
    if (!existsSync(file)) return [];
    try {
      return JournalSchema.parse(JSON.parse(readFileSync(file, "utf8"))).jobs;
    } catch {
      // Unreadable requests are dropped, never dispatched: an agent asks again.
      return [];
    }
  };
  let jobs = read();
  const write = () => {
    const active = jobs.filter((job) => !finished(job));
    const done = jobs.filter(finished).slice(-RETAINED);
    jobs = [...done, ...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(file, JSON.stringify({ version: 1, jobs }));
  };
  const save = (job: QueuedAgentAction, changes: Partial<QueuedAgentAction>) => {
    const next = QueuedAgentActionSchema.parse({
      ...job,
      ...changes,
      revision: changes.revision ?? randomUUID(),
    });
    jobs = jobs.map((item) => (item.id === job.id ? next : item));
    write();
    return next;
  };
  const finish = (
    job: QueuedAgentAction,
    status: "succeeded" | "failed" | "cancelled",
    detail: string,
  ) => save(job, { status, detail, finishedAt: now().toISOString() });

  let draining: Promise<void> | null = null;

  async function drainOnce(): Promise<void> {
    for (const job of jobs.filter((item) => item.status === "pending")) admit(job);
    const running = jobs.find((item) => item.status === "running" || item.status === "restoring");
    if (running) return follow(running);
    const approved = jobs.find((item) => item.status === "approved");
    if (approved) await dispatch(approved);
  }

  /** The full grant approves a fresh request after its window; owner approval otherwise. */
  function admit(job: QueuedAgentAction) {
    const grant = input.grant();
    const time = now().getTime();
    const step = delegatedAdmissionStep(
      { ...job, requestedBy: "host-agent" },
      { grant, operations: [operation(job)], planSha256: plan(job), now: time },
    );
    if (step === "attach" && grant) {
      const revision = randomUUID();
      const approval = delegatedApproval(grant, {
        requestRevision: revision,
        planSha256: plan(job),
        now: time,
        cancellationDelayMs: delayMs,
      });
      save(job, {
        revision,
        delegatedApproval: approval,
        detail: `Approved under owner maintenance delegation. Starts after ${approval.dispatchAfter} unless cancelled.`,
      });
    } else if (step === "invalid") {
      finish(job, "cancelled", "Delegated approval changed before dispatch. Nothing changed.");
    } else if (step === "ready") {
      save(job, {
        status: "approved",
        approvedAt: now().toISOString(),
        detail: "Approved under owner maintenance delegation. Starting.",
      });
    }
  }

  async function dispatch(job: QueuedAgentAction) {
    const action = definition(job.action);
    const lapsed = () =>
      !delegatedDispatchHolds(job.delegatedApproval, input.grant(), {
        operations: [operation(job)],
        planSha256: plan(job),
      });
    if (lapsed()) {
      finish(job, "cancelled", "Delegated approval changed before dispatch. Nothing changed.");
      return;
    }
    const conflict = input.conflict?.();
    if (conflict) {
      finish(job, "failed", `${conflict} Nothing changed.`);
      return;
    }
    try {
      await action.preflight?.(job.request);
    } catch (error) {
      finish(job, "failed", `Preflight refused the change: ${message(error)}. Nothing changed.`);
      return;
    }
    let previous: unknown;
    try {
      previous = await action.capture();
    } catch (error) {
      finish(
        job,
        "failed",
        `The current value could not be read: ${message(error)}. Nothing changed.`,
      );
      return;
    }
    // The owner may have cancelled, or the grant lapsed, during the preflight or the capture:
    // checked last, immediately before the running record and the effect.
    const current = jobs.find((item) => item.id === job.id);
    if (current?.status !== "approved" || current.revision !== job.revision) return;
    if (lapsed()) {
      finish(job, "cancelled", "Delegated approval changed before dispatch. Nothing changed.");
      return;
    }
    const blocked = input.conflict?.();
    if (blocked) {
      finish(job, "failed", `${blocked} Nothing changed.`);
      return;
    }
    // Recorded with the value to restore before any effect: a change that restarts the
    // coordinator resumes from here in the next one.
    const running = save(job, {
      status: "running",
      startedAt: now().toISOString(),
      previous: previous ?? null,
      detail: "Applying the change.",
    });
    let detail: string;
    try {
      detail = await action.apply(job.request);
    } catch (error) {
      finish(running, "failed", `The change failed: ${message(error)}`);
      return;
    }
    const latest = jobs.find((item) => item.id === job.id);
    if (latest?.status !== "running") return;
    await follow(save(latest, { detail }));
  }

  /**
   * Completes a running change, also after a coordinator restart: once it settles, success
   * requires the requested state in effect and, for remote-access changes, both addresses
   * answering. Otherwise the previous value is restored once, durably, never recursively.
   */
  async function follow(job: QueuedAgentAction) {
    const action = definition(job.action);
    if (action.settled && !(await action.settled())) return;
    if (job.status === "restoring") return finishRestore(job, action);
    const state = await action.state(job.request);
    // Not in effect: the coordinator stopped before applying it, or the handoff restored the
    // previous configuration itself. There is nothing of this request's to undo.
    if (!state.applied) {
      finish(job, "failed", `The change did not take effect: ${state.detail}`);
      return;
    }
    const evidence = (await action.reachable?.(job.request)) ?? null;
    if (!evidence) {
      finish(job, "succeeded", job.detail);
      return;
    }
    if (!action.restore || job.previous === undefined) {
      finish(job, "failed", `${evidence} The previous value cannot be restored automatically.`);
      return;
    }
    // Durable before the restore: a restore that restarts the coordinator resumes here, and the
    // revision read before the reachability wait refuses it if the owner changed the value since.
    const restoring = save(job, {
      status: "restoring",
      restoreRevision: state.revision,
      detail: evidence,
    });
    await finishRestore(restoring, action);
  }

  /**
   * Restores the previous value, at most RESTORE_ATTEMPTS times, and records whether it is back.
   * The first attempt is compare-and-set against `restoreRevision`, read before the reachability
   * wait, so an owner change during the wait is never overwritten. A later attempt, after a
   * coordinator that stopped mid-restore, retries only while the value is still the one this
   * request set: any other value means the owner changed it, and it stays.
   */
  async function finishRestore(job: QueuedAgentAction, action: QueuedActionDefinition) {
    if (action.settled && !(await action.settled())) return;
    if (await isBack(job, action)) {
      finish(job, "failed", `${job.detail} Restored the previous value.`);
      return;
    }
    const attempts = job.restoreAttempts ?? 0;
    const state = await action.state(job.request);
    let revision = job.restoreRevision ?? "";
    if (attempts > 0) {
      // Retry only when the earlier attempt changed nothing, or when the last change is that
      // attempt itself, interrupted. Any other change is a newer decision, matching value or not.
      const untouched = state.revision === job.restoreRevision;
      const ours = state.operation !== undefined && state.operation === job.restoreOperation;
      if (!untouched && !ours) {
        finish(job, "failed", `${job.detail} The value changed since, so it was not restored.`);
        return;
      }
      revision = state.revision;
    }
    if (attempts >= RESTORE_ATTEMPTS) {
      finish(
        job,
        "failed",
        `${job.detail} The restore did not take effect after ${attempts} attempts; check it in Installation controls.`,
      );
      return;
    }
    const restoreId = randomUUID();
    const attempting = save(job, { restoreAttempts: attempts + 1, restoreOperation: restoreId });
    try {
      await action.restore!(job.previous, revision, restoreId);
    } catch (error) {
      finish(attempting, "failed", `${job.detail} Not restored: ${message(error)}`);
      return;
    }
    // A restore that restarts the coordinator settles first; the next one reconciles it.
    if (action.settled && !(await action.settled())) return;
    await finishRestore(jobs.find((item) => item.id === job.id)!, action);
  }

  async function isBack(job: QueuedAgentAction, action: QueuedActionDefinition) {
    return JSON.stringify(await action.capture()) === JSON.stringify(job.previous ?? null);
  }

  return {
    list: () => structuredClone(jobs),
    get: (id) => structuredClone(jobs.find((job) => job.id === id) ?? null),
    request(name, body, requester) {
      const action = definition(name);
      if (!delegableUnderGrant(`queued:${name}`))
        throw new RestartRequestError("Only the owner makes this change.");
      if (jobs.some((job) => job.action === name && !finished(job)))
        throw new RestartRequestError("A request for this change is already waiting or running.");
      const request = action.schema.parse(body);
      const job = QueuedAgentActionSchema.parse({
        id: randomUUID(),
        revision: randomUUID(),
        action: name,
        request,
        ...(requester ? { requester } : {}),
        disruption: action.disruption(request),
        createdAt: now().toISOString(),
        status: "pending",
        detail: "Waiting for owner approval.",
      });
      jobs = [...jobs, job];
      write();
      return structuredClone(job);
    },
    decide(id, revision, decision) {
      const job = jobs.find((item) => item.id === id);
      if (!job || job.revision !== revision)
        throw new RestartRequestError("The request changed. Review it again.");
      if (decision === "cancel") {
        if (job.status !== "pending" && job.status !== "approved")
          throw new RestartRequestError(`A request that is ${job.status} cannot be cancelled.`);
        return structuredClone(finish(job, "cancelled", "Cancelled. Nothing changed."));
      }
      if (job.status !== "pending")
        throw new RestartRequestError(`A request that is ${job.status} cannot be approved.`);
      return structuredClone(
        save(job, {
          status: "approved",
          approvedAt: now().toISOString(),
          // The owner's approval replaces a delegated one.
          delegatedApproval: undefined,
          detail: "Approved. Starting.",
        }),
      );
    },
    drain() {
      draining ??= drainOnce().finally(() => {
        draining = null;
      });
      return draining;
    },
  };
}

function finished(job: QueuedAgentAction) {
  // "restoring" is active: it still owes its outcome.
  return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
