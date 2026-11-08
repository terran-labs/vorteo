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
  /** After the change: null when the owner can still reach the installation, else the evidence. */
  verify?(): Promise<string | null>;
  /** Puts `previous` back after a failed verification. */
  restore?(previous: unknown): Promise<void>;
}

const JournalSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.array(QueuedAgentActionSchema),
});

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
    const running = jobs.find((item) => item.status === "running");
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
    // The grant may have lapsed, or the owner cancelled, during the preflight.
    const current = jobs.find((item) => item.id === job.id);
    if (current?.status !== "approved" || current.revision !== job.revision) return;
    if (lapsed()) {
      finish(job, "cancelled", "Delegated approval changed before dispatch. Nothing changed.");
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

  /** Completes a running change: waits for it to settle, verifies access and restores on failure. */
  async function follow(job: QueuedAgentAction) {
    const action = definition(job.action);
    if (action.settled && !(await action.settled())) return;
    const evidence = await action.verify?.();
    if (!evidence) {
      finish(job, "succeeded", job.detail);
      return;
    }
    if (!action.restore || job.previous === undefined) {
      finish(job, "failed", `${evidence} The previous value could not be restored automatically.`);
      return;
    }
    // Failed first, so a restore that restarts the coordinator is never restored again.
    finish(job, "failed", `${evidence} Restoring the previous value.`);
    try {
      await action.restore(job.previous);
    } catch (error) {
      const latest = jobs.find((item) => item.id === job.id)!;
      save(latest, { detail: `${evidence} The restore failed: ${message(error)}` });
    }
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
  return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
