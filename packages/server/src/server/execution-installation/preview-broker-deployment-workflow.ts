import { createHash, randomUUID } from "node:crypto";
import {
  PreviewBrokerDeploymentDecisionSchema,
  PreviewBrokerDeploymentObservationSchema,
  PreviewBrokerDeploymentPreparationSchema,
  type PreviewBrokerDeploymentJob,
  type PreviewBrokerDeploymentObservation,
  type PreviewBrokerDeploymentPlan,
} from "@getpaseo/protocol/preview-broker-deployment";

export interface BrokerDeploymentExecutor {
  brokerDeploymentCompatible(): Promise<boolean>;
  validateBrokerDeploymentPlan(plan: PreviewBrokerDeploymentPlan): Promise<void>;
  executeBrokerDeployment(
    job: PreviewBrokerDeploymentJob,
    assertCurrentReservation: () => void,
  ): Promise<PreviewBrokerDeploymentObservation>;
  observeBrokerDeployment(
    job: PreviewBrokerDeploymentJob,
  ): Promise<PreviewBrokerDeploymentObservation>;
}

interface DeploymentQueue {
  requireActive(): void;
  snapshot(): unknown;
  requestExists(id: string): boolean;
  jobs(): PreviewBrokerDeploymentJob[];
  replace(job: PreviewBrokerDeploymentJob): void;
  executor?: BrokerDeploymentExecutor;
  now(): number;
}

export class BrokerDeploymentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerDeploymentRefused";
  }
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The installation queue remains the sole journal and dispatch owner. */
export class PreviewBrokerDeploymentWorkflow {
  constructor(private readonly queue: DeploymentQueue) {}

  async prepare(input: unknown, requestedBy: string): Promise<PreviewBrokerDeploymentJob> {
    this.queue.requireActive();
    if (requestedBy !== "host-agent")
      throw new BrokerDeploymentRefused("Consumer deployment requires authenticated Host access");
    const prepared = PreviewBrokerDeploymentPreparationSchema.parse(input);
    const planSha256 = digest(prepared.plan);
    const existing = this.queue.jobs().find((job) => job.id === prepared.id);
    if (existing) {
      if (existing.planSha256 !== planSha256 || existing.reason !== prepared.reason)
        throw new BrokerDeploymentRefused("Request identity belongs to different deployment work");
      return structuredClone(existing);
    }
    if (this.queue.requestExists(prepared.id))
      throw new BrokerDeploymentRefused("Request identity belongs to another lifecycle target");
    const assertUnchanged = this.reservation();
    if (!(await this.executor().brokerDeploymentCompatible()))
      throw new BrokerDeploymentRefused(
        "Compatible selected and recovery deployment readers required",
      );
    assertUnchanged();
    const job: PreviewBrokerDeploymentJob = {
      ...prepared,
      target: "preview-broker-deployment",
      operation: "preview-broker-consumer-deployment",
      revision: randomUUID(),
      requestedBy: "host-agent",
      createdAt: new Date(this.queue.now()).toISOString(),
      planSha256,
      status: "pending",
      stage: "preparing",
      detail: "Checking exact consumer files, preserved requests and declared native participants",
    };
    this.queue.replace(job);
    const assertCurrent = this.reservation();
    try {
      await this.executor().validateBrokerDeploymentPlan(structuredClone(job.plan));
      assertCurrent();
      this.queue.replace({
        ...job,
        stage: "prepared",
        detail: "Review consumer replacement. Channel trust rebind requires a separate approval.",
      });
    } catch {
      const current = this.current(job.id);
      if (current.status === "pending" && current.revision === job.revision)
        this.queue.replace({
          ...current,
          status: "failed",
          detail: "Consumer preparation refused",
        });
    }
    return structuredClone(this.current(job.id));
  }

  decide(input: unknown): PreviewBrokerDeploymentJob {
    this.queue.requireActive();
    const decision = PreviewBrokerDeploymentDecisionSchema.parse(input);
    const job = this.current(decision.id);
    if (
      job.revision !== decision.revision ||
      job.planSha256 !== decision.planSha256 ||
      digest(job.plan) !== job.planSha256
    )
      throw new BrokerDeploymentRefused("Review the exact current deployment revision and plan");
    if (decision.decision === "cancel") {
      if (job.status !== "pending" && job.status !== "approved")
        throw new BrokerDeploymentRefused("Deployment already dispatched or decided");
      this.queue.replace({ ...job, status: "rejected", detail: "Consumer deployment canceled" });
    } else {
      if (job.status !== "pending" || job.stage !== "prepared")
        throw new BrokerDeploymentRefused("Deployment is not prepared for approval");
      this.queue.replace({
        ...job,
        status: "approved",
        approvedAt: new Date(this.queue.now()).toISOString(),
        detail: "Exact consumer deployment approved",
      });
    }
    return structuredClone(this.current(job.id));
  }

  async dispatch(id: string): Promise<void> {
    this.queue.requireActive();
    const job = this.current(id);
    if (job.status !== "approved" || !job.approvedAt || digest(job.plan) !== job.planSha256)
      throw new BrokerDeploymentRefused("Deployment has no exact dispatch approval");
    const assertPrepared = this.reservation();
    try {
      if (!(await this.executor().brokerDeploymentCompatible()))
        throw new BrokerDeploymentRefused("Consumer deployment capability unavailable");
      assertPrepared();
      await this.executor().validateBrokerDeploymentPlan(structuredClone(job.plan));
      assertPrepared();
      const dispatched: PreviewBrokerDeploymentJob = {
        ...job,
        status: "running",
        stage: "dispatch_pending",
        detail: "Replacing approved consumers in the verified native maintenance window",
      };
      this.queue.replace(dispatched);
      const assertCurrentReservation = this.reservation();
      const observation = PreviewBrokerDeploymentObservationSchema.parse(
        await this.executor().executeBrokerDeployment(
          structuredClone(dispatched),
          assertCurrentReservation,
        ),
      );
      assertCurrentReservation();
      this.validateObservation(dispatched, observation);
      if (observation.kind !== "committed")
        throw new BrokerDeploymentRefused("Native deployment commitment remains unverified");
      this.queue.replace({
        ...dispatched,
        status: "succeeded",
        stage: "succeeded",
        observation,
        detail: "Consumer deployment verified. Channel trust rebind remains separate.",
      });
    } catch {
      const current = this.current(id);
      if (current.status === "rejected") return;
      this.queue.replace({
        ...current,
        status: "failed",
        stage: current.status === "running" ? "recovery_required" : "prepared",
        detail: "Deployment refused or uncertain. Preserve receipts; never replay automatically.",
      });
    }
  }

  async observe(id: string): Promise<void> {
    const job = structuredClone(this.current(id));
    if (job.stage !== "recovery_required" || !job.approvedAt) return;
    // Recovery performs only independent observation. It never prepares or dispatches.
    const observation = PreviewBrokerDeploymentObservationSchema.parse(
      await this.executor().observeBrokerDeployment(job),
    );
    this.validateObservation(job, observation);
    const current = this.current(id);
    if (JSON.stringify(current) !== JSON.stringify(job)) return;
    const committed = observation.kind === "committed";
    this.queue.replace({
      ...current,
      observation,
      status: committed ? "succeeded" : "failed",
      stage: committed ? "succeeded" : "recovery_required",
      detail: committed
        ? "Native deployment commitment independently verified without replay"
        : "Deployment remains unresolved; retain the maintenance fence",
    });
  }

  private executor(): BrokerDeploymentExecutor {
    if (!this.queue.executor)
      throw new BrokerDeploymentRefused("Consumer deployment executor is unavailable");
    return this.queue.executor;
  }

  private current(id: string): PreviewBrokerDeploymentJob {
    const job = this.queue.jobs().find((item) => item.id === id);
    if (!job) throw new BrokerDeploymentRefused("Deployment request is not retained");
    return job;
  }

  private reservation(): () => void {
    const retained = JSON.stringify(this.queue.snapshot());
    return () => {
      this.queue.requireActive();
      if (JSON.stringify(this.queue.snapshot()) !== retained)
        throw new BrokerDeploymentRefused("Full installation queue reservation changed");
    };
  }

  private validateObservation(
    job: PreviewBrokerDeploymentJob,
    observation: PreviewBrokerDeploymentObservation,
  ): void {
    if (observation.id !== job.id || observation.planSha256 !== job.planSha256)
      throw new BrokerDeploymentRefused("Observation belongs to another deployment");
  }
}
