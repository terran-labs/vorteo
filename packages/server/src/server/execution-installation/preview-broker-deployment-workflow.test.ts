import { assertCoordinatorLifecycleIdle } from "./coordinator-bootstrap.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PreviewBrokerDeploymentPreparationSchema,
  type PreviewBrokerDeploymentJob,
  type PreviewBrokerDeploymentObservation,
} from "@getpaseo/protocol/preview-broker-deployment";
import {
  PreviewBrokerDeploymentWorkflow,
  type BrokerDeploymentExecutor,
} from "./preview-broker-deployment-workflow.js";

function fixture() {
  const id = randomUUID();
  const hash = "a".repeat(64);
  const file = { path: "/protected/file", sha256: hash };
  const expected = { kind: "present", sha256: hash, identity: Array(9).fill("1") };
  const consumer = { expected, candidate: file, mode: 0o600 };
  const target = (root: string) => ({
    root,
    directory: [1, 2, 501, 20, 0o700],
    preservationSha256: hash,
    files: {
      "https_broker.py": consumer,
      "https-preview.py": consumer,
      "host_config.py": consumer,
      "channel_identity.py": { ...consumer, expected: { kind: "absent" } },
    },
  });
  const input = PreviewBrokerDeploymentPreparationSchema.parse({
    id,
    reason: "Deploy reviewed broker consumers",
    plan: {
      version: 1,
      operation: "preview-broker-consumer-deployment",
      id,
      installationId: randomUUID(),
      sourceCommit: "a".repeat(40),
      evidenceDirectory: `/evidence/${id}`,
      evidenceDirectoryIdentity: [1, 2, 501, 20, 0o700],
      bootUUID: randomUUID(),
      targets: [target("/host"), target("/dev")],
      registrations: [
        {
          root: "/host",
          domain: "gui/501",
          enabled: true,
          override: "absent",
          label: "host",
          plist: file,
          disposition: "absent",
          process: null,
        },
        {
          root: "/dev",
          domain: "gui/501",
          enabled: true,
          override: "absent",
          label: "dev",
          plist: file,
          disposition: "absent",
          process: null,
        },
      ],
      participantEvidence: [file],
      manualParticipants: [],
    },
  });
  let jobs: PreviewBrokerDeploymentJob[] = [];
  const unrelated: string[] = [];
  const observation = (job: PreviewBrokerDeploymentJob): PreviewBrokerDeploymentObservation => ({
    kind: "committed",
    id: job.id,
    planSha256: job.planSha256,
    commitSha256: hash,
    preservationSha256: hash,
    registrationsSha256: hash,
    installedFilesSha256: hash,
  });
  const executor: BrokerDeploymentExecutor = {
    brokerDeploymentCompatible: vi.fn(async () => true),
    validateBrokerDeploymentPlan: vi.fn(async () => {}),
    executeBrokerDeployment: vi.fn(async (job, assertCurrent) => {
      assertCurrent();
      return observation(job);
    }),
    observeBrokerDeployment: vi.fn(async (job) => observation(job)),
  };
  const workflow = new PreviewBrokerDeploymentWorkflow({
    requireActive() {},
    snapshot: () => ({ jobs, unrelated }),
    requestExists: (candidate) => jobs.some((job) => job.id === candidate),
    jobs: () => structuredClone(jobs),
    replace: (job) => {
      jobs = [...jobs.filter((prior) => prior.id !== job.id), structuredClone(job)];
    },
    executor,
    now: Date.now,
  });
  const approve = async () => {
    const job = await workflow.prepare(input, "host-agent");
    return workflow.decide({
      operation: input.plan.operation,
      id,
      revision: job.revision,
      planSha256: job.planSha256,
      decision: "approve",
    });
  };
  return { workflow, input, executor, unrelated, approve, jobs: () => jobs };
}

describe("broker consumer deployment queue boundary", () => {
  it("requires exact approval and independent committed proof", async () => {
    const f = fixture();
    await f.workflow.prepare(f.input, "host-agent");
    await expect(f.workflow.dispatch(f.input.id)).rejects.toThrow("dispatch approval");
    await f.approve();
    await f.workflow.dispatch(f.input.id);
    expect(f.jobs()[0].status).toBe("succeeded");
    expect(f.executor.executeBrokerDeployment).toHaveBeenCalledTimes(1);
    await expect(f.workflow.dispatch(f.input.id)).rejects.toThrow("dispatch approval");
  });

  it("composes full queue reservation into the effect boundary", async () => {
    const f = fixture();
    await f.approve();
    f.executor.executeBrokerDeployment = vi.fn(async (_job, assertCurrent) => {
      f.unrelated.push("another lifecycle request");
      assertCurrent();
      throw new Error("unreachable");
    });
    await f.workflow.dispatch(f.input.id);
    expect(f.jobs()[0].stage).toBe("recovery_required");
    expect(f.jobs()[0].status).toBe("failed");
    expect(f.executor.executeBrokerDeployment).toHaveBeenCalledTimes(1);
  });

  it("recovery observes without preparation or effect replay", async () => {
    const f = fixture();
    await f.approve();
    f.executor.executeBrokerDeployment = vi.fn(async () => {
      throw new Error("lost child response");
    });
    await f.workflow.dispatch(f.input.id);
    const preparations = vi.mocked(f.executor.validateBrokerDeploymentPlan).mock.calls.length;
    await f.workflow.observe(f.input.id);
    expect(f.jobs()[0].status).toBe("succeeded");
    expect(f.executor.executeBrokerDeployment).toHaveBeenCalledTimes(1);
    expect(f.executor.validateBrokerDeploymentPlan).toHaveBeenCalledTimes(preparations);
    expect(f.executor.observeBrokerDeployment).toHaveBeenCalledTimes(1);
  });

  it("refuses wrong-plan observations instead of publishing terminal success", async () => {
    const f = fixture();
    await f.approve();
    f.executor.executeBrokerDeployment = vi.fn(async (job) => ({
      kind: "unresolved",
      id: randomUUID(),
      planSha256: job.planSha256,
      reason: "evidence-unconfirmed",
    }));
    await f.workflow.dispatch(f.input.id);
    expect(f.jobs()[0].stage).toBe("recovery_required");
    expect(f.jobs()[0].status).toBe("failed");
  });
});

it("fences coordinator replacement throughout deployment and unresolved recovery", async () => {
  const f = fixture();
  const job = await f.workflow.prepare(f.input, "host-agent");
  for (const [status, stage] of [
    ["pending", "preparing"],
    ["approved", "prepared"],
    ["running", "dispatch_pending"],
    ["failed", "recovery_required"],
  ]) {
    expect(() => assertCoordinatorLifecycleIdle([{ ...job, status, stage }])).toThrow("unresolved");
  }
  for (const [status, stage] of [
    ["pending", "prepared"],
    ["rejected", "prepared"],
    ["succeeded", "succeeded"],
  ]) {
    expect(() => assertCoordinatorLifecycleIdle([{ ...job, status, stage }])).not.toThrow();
  }
});
