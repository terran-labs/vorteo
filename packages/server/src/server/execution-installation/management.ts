import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { managementDelegationAuthority } from "./owner-delegation.js";
import { DaemonAutomation } from "./daemon-automation.js";
import { InstallationRestarts, RestartRequestError } from "./restarts.js";
import type { BootstrapReconciliationLedger } from "./coordinator-bootstrap.js";

const KindSchema = z.enum([
  "restart",
  "coordinator",
  "service",
  "broker-deployment",
  "broker-rebind",
  "monitor",
  "helper",
  "session-host",
]);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CancellationSchema = z.strictObject({
  receiptId: z.string().uuid(),
  authorityRevision: DigestSchema,
  kind: KindSchema,
  id: z.string().uuid(),
  revision: z.string().uuid(),
  jobSha256: DigestSchema,
});
type Cancellation = z.infer<typeof CancellationSchema>;
interface ManagedJob {
  id: string;
  revision: string;
  status: string;
}
interface Queue {
  list(): ManagedJob[];
  cancel(input: Cancellation): ManagedJob;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Decisions reuse the lifecycle owners. This surface cannot approve, grant authority,
 * replace a plan, or release a claimed execution. */
export class InstallationManagement {
  constructor(
    private readonly stateDir: string,
    private readonly restarts: InstallationRestarts,
    private readonly coordinator: BootstrapReconciliationLedger | undefined,
  ) {}

  available() {
    return (
      typeof process.getuid === "function" &&
      new DaemonAutomation(this.stateDir, false).legacyPolicyAvailable()
    );
  }

  authority() {
    if (!this.available()) return null;
    try {
      return managementDelegationAuthority(this.stateDir);
    } catch {
      // Unreadable protected authority never advertises or enables management.
      return null;
    }
  }

  private assertAuthority(revision: string): void {
    if (this.authority()?.revision !== revision)
      throw new RestartRequestError("Installation management grant changed or is disabled");
  }

  private queues(): Record<z.infer<typeof KindSchema>, Queue> {
    const r = this.restarts;
    const planDecision = (
      input: Cancellation,
      jobs: { id: string; operation: string; planSha256: string }[],
    ) => {
      const job = jobs.find((item) => item.id === input.id);
      if (!job) throw new RestartRequestError("Installation request is missing");
      return {
        id: input.id,
        revision: input.revision,
        operation: job.operation,
        planSha256: job.planSha256,
        decision: "cancel",
      };
    };
    return {
      restart: {
        list: () => r.list(),
        cancel: (input) => {
          const job = r.list().find((item) => item.id === input.id);
          if (!job) throw new RestartRequestError("Installation request is missing");
          return r.decide(input.id, input.revision, job.status === "pending" ? "reject" : "cancel");
        },
      },
      coordinator: {
        list: () => this.coordinator?.list() ?? [],
        cancel: (input) => {
          if (!this.coordinator?.cancelUnderManagement)
            throw new RestartRequestError("Coordinator management cancellation is unavailable");
          const job = this.coordinator.list().find((item) => item.id === input.id);
          if (!job) throw new RestartRequestError("Coordinator request is missing");
          return this.coordinator.cancelUnderManagement(
            {
              id: input.id,
              revision: input.revision,
              planSha256: job.planSha256,
              decision: "cancel",
            },
            () => this.assertAuthority(input.authorityRevision),
          );
        },
      },
      service: {
        list: () => r.listServices(),
        cancel: (input) => r.cancelService(input.id, input.revision),
      },
      "broker-deployment": {
        list: () => r.listBrokerDeployments(),
        cancel: (input) => r.decideBrokerDeployment(planDecision(input, r.listBrokerDeployments())),
      },
      "broker-rebind": {
        list: () => r.listBrokers(),
        cancel: (input) => r.decideBroker(planDecision(input, r.listBrokers())),
      },
      monitor: {
        list: () => r.listMonitors(),
        cancel: (input) => r.decideMonitor(planDecision(input, r.listMonitors())),
      },
      helper: {
        list: () => r.listHelpers(),
        cancel: (input) => r.decideHelper(planDecision(input, r.listHelpers())),
      },
      "session-host": {
        list: () => r.listSessionHosts(),
        cancel: (input) => r.decideSessionHost(planDecision(input, r.listSessionHosts())),
      },
    };
  }

  snapshot() {
    const authority = this.authority();
    if (!authority) throw new RestartRequestError("Installation management is disabled");
    const queues = this.queues();
    const jobs = KindSchema.options.flatMap((kind) =>
      queues[kind].list().map((job) => ({
        kind,
        id: job.id,
        revision: job.revision,
        status: job.status,
        jobSha256: digest(job),
      })),
    );
    return {
      authority,
      jobs,
      coordinatorCancellation: Boolean(this.coordinator?.cancelUnderManagement),
    };
  }

  cancel(value: unknown) {
    const input = CancellationSchema.parse(value);
    this.assertAuthority(input.authorityRevision);
    const queue = this.queues()[input.kind];
    const job = queue.list().find((item) => item.id === input.id);
    if (!job || job.revision !== input.revision || digest(job) !== input.jobSha256)
      throw new RestartRequestError(
        "Exact installation request changed; refresh before cancellation",
      );
    const intent = {
      version: 1,
      actor: "host-agent",
      action: "cancel",
      ...input,
      at: new Date().toISOString(),
      status: "intent",
    };
    // Exclusive durable intent prevents a lost response from becoming a repeated effect.
    this.writeReceipt(input.receiptId, "intent", intent);
    this.assertAuthority(input.authorityRevision);
    const result = queue.cancel(input);
    const receipt = {
      ...intent,
      status: "completed",
      result: {
        id: result.id,
        revision: result.revision,
        status: result.status,
        jobSha256: digest(result),
      },
    };
    this.writeReceipt(input.receiptId, "result", receipt);
    return receipt;
  }

  receipt(id: string) {
    z.string().uuid().parse(id);
    if (!this.authority()) throw new RestartRequestError("Installation management is disabled");
    const intent = JSON.parse(readFileSync(this.receiptPath(id, "intent"), "utf8"));
    try {
      return JSON.parse(readFileSync(this.receiptPath(id, "result"), "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      return {
        ...intent,
        status: "uncertain",
        detail: "Observe the retained request; do not replay cancellation.",
      };
    }
  }

  private receiptPath(id: string, phase: string) {
    return path.join(this.stateDir, `management-${id}-${phase}.json`);
  }

  private writeReceipt(id: string, phase: string, value: unknown) {
    const fd = openSync(
      this.receiptPath(id, phase),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = openSync(this.stateDir, constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
}
