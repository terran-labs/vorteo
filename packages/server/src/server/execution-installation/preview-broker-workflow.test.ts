import { createInstallationServer } from "./server.js";
import { hashDaemonPassword } from "../auth.js";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { InstallationRestarts, type RestartExecutor } from "./restarts.js";
import { parseLifecycleJournal, type LifecycleJob } from "./lifecycle-journal.js";
import { compatibilityProbe } from "./preview-broker-executor.js";
import { assertCoordinatorLifecycleIdle } from "./coordinator-bootstrap.js";
import {
  PreviewBrokerJobSchema,
  type PreviewBrokerJob,
} from "@getpaseo/protocol/preview-broker-maintenance";

function fixture(overrides: Partial<RestartExecutor> = {}) {
  let records: LifecycleJob[] = [];
  const journal = {
    read: () => structuredClone(records),
    write: (jobs: LifecycleJob[]) => {
      records = parseLifecycleJournal(jobs);
    },
  };
  const install = vi.fn(async () => "Verified");
  const executor: RestartExecutor = {
    restart: vi.fn(async () => "ready"),
    brokerCompatible: async () => true,
    validateBrokerPlan: async () => {},
    installBroker: install,
    ...overrides,
  };
  const queue = new InstallationRestarts(journal, executor, Date.now, {
    hostRequestsAfter: "2026-01-01T00:00:00.000Z",
    maintenanceRequestsAfter: () => "2026-01-01T00:00:00.000Z",
    authority: () => "a".repeat(64),
    cancellationDelayMs: 0,
  });
  const probe = compatibilityProbe(randomUUID());
  const input = { id: probe.id, plan: probe.plan, reason: "Reviewed trust migration" };
  return {
    journal,
    queue,
    executor,
    install,
    input,
    prepare: () => queue.prepareBroker(input, "host-agent"),
  };
}
function decision(job: PreviewBrokerJob, action: "approve" | "cancel" = "approve") {
  return {
    id: job.id,
    revision: job.revision,
    planSha256: job.planSha256,
    operation: job.operation,
    decision: action,
  };
}

test("lost apply response settles only from an exact committed observation without replay", async () => {
  const installBroker = vi.fn(async () => {
    throw Error("response lost");
  });
  const observeBrokerOutcome = vi.fn(async (job: PreviewBrokerJob) => ({
    kind: "committed" as const,
    id: job.id,
    planSha256: job.planSha256,
    workerPlanSha256: "d".repeat(64),
    commitSha256: "e".repeat(64),
    configSelections: ["candidate", "candidate"] as ["candidate", "candidate"],
    inventorySha256: ["a".repeat(64), "b".repeat(64)],
    reason: "commit-confirmed" as const,
  }));
  const f = fixture({ installBroker, observeBrokerOutcome });
  f.queue.decideBroker(decision(await f.prepare()));
  await f.queue.drain();
  expect(f.queue.listBrokers()[0]!.stage).toBe("recovery_required");
  await f.queue.drain();
  expect(f.queue.listBrokers()[0]!.status).toBe("succeeded");
  expect(f.queue.listBrokers()[0]!.observation?.kind).toBe("committed");
  expect(installBroker).toHaveBeenCalledTimes(1);
  expect(observeBrokerOutcome).toHaveBeenCalledTimes(1);
});

test("precommit held observation retains recovery and never repeats apply", async () => {
  const installBroker = vi.fn(async () => {
    throw Error("worker lost");
  });
  const f = fixture({
    installBroker,
    observeBrokerOutcome: async (job) => ({
      kind: "precommit-held",
      id: job.id,
      planSha256: job.planSha256,
      workerPlanSha256: "d".repeat(64),
      configSelections: ["candidate", "original"],
      inventorySha256: ["a".repeat(64)],
      reason: "commit-absent",
    }),
  });
  f.queue.decideBroker(decision(await f.prepare()));
  await f.queue.drain();
  await f.queue.drain();
  expect(f.queue.listBrokers()[0]!.stage).toBe("recovery_required");
  expect(f.queue.listBrokers()[0]!.observation?.kind).toBe("precommit-held");
  expect(installBroker).toHaveBeenCalledTimes(1);
});

test("foreign observation identity cannot settle an uncertain request", async () => {
  const f = fixture({
    installBroker: async () => {
      throw Error("lost");
    },
    observeBrokerOutcome: async (job) => ({
      kind: "unresolved",
      id: randomUUID(),
      planSha256: job.planSha256,
      workerPlanSha256: "d".repeat(64),
      reason: "evidence-unconfirmed",
    }),
  });
  f.queue.decideBroker(decision(await f.prepare()));
  await f.queue.drain();
  await f.queue.drain();
  expect(f.queue.listBrokers()[0]!.stage).toBe("recovery_required");
  expect(f.queue.listBrokers()[0]!.observation).toBeUndefined();
});

test("manual exact approval dispatches once; daemon policy cannot approve broker trust", async () => {
  const f = fixture();
  const job = await f.prepare();
  await f.queue.drain();
  expect(f.install).not.toHaveBeenCalled();
  for (const change of [
    { revision: randomUUID() },
    { planSha256: "0".repeat(64) },
    { operation: "preview-monitor-replace" },
  ])
    expect(() => f.queue.decideBroker({ ...decision(job), ...change })).toThrow();
  expect(() => f.queue.decide(job.id, job.revision, "approve")).toThrow();
  f.queue.decideBroker(decision(job));
  await f.queue.drain();
  await f.queue.drain();
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.queue.listBrokers()[0]?.status).toBe("succeeded");
  expect(f.executor.restart).not.toHaveBeenCalled();
});

test("incompatible selected or recovery reader refuses before first journal append", async () => {
  const f = fixture({ brokerCompatible: async () => false });
  await expect(f.prepare()).rejects.toThrow("compatible");
  expect(f.journal.read()).toEqual([]);
});

test("request credentials and duplicate plan identities cannot widen scope", async () => {
  const f = fixture();
  await expect(f.queue.prepareBroker(f.input, "container-agent")).rejects.toThrow("Host access");
  const job = await f.prepare();
  expect((await f.prepare()).id).toBe(job.id);
  await expect(
    f.queue.prepareBroker({ ...f.input, reason: "Changed" }, "host-agent"),
  ).rejects.toThrow("different work");
  expect(() => PreviewBrokerJobSchema.parse({ ...job, delegatedApproval: {} })).toThrow();
});

test("cancel during dispatch validation prevents all effects", async () => {
  const f = fixture();
  const job = await f.prepare();
  f.queue.decideBroker(decision(job));
  f.executor.validateBrokerPlan = async () => {
    f.queue.decideBroker(decision(job, "cancel"));
  };
  await f.queue.drain();
  expect(f.install).not.toHaveBeenCalled();
  expect(f.queue.listBrokers()[0]?.status).toBe("rejected");
});

test("failure after durable dispatch fences maintenance and never replays", async () => {
  const f = fixture({
    installBroker: async () => {
      throw new Error("partial");
    },
  });
  const job = await f.prepare();
  f.queue.decideBroker(decision(job));
  await f.queue.drain();
  expect(f.queue.listBrokers()[0]?.stage).toBe("recovery_required");
  expect(() => assertCoordinatorLifecycleIdle(f.journal.read())).toThrow();
  const resumed = new InstallationRestarts(f.journal, f.executor);
  await resumed.drain();
  expect(resumed.listBrokers()[0]?.stage).toBe("recovery_required");
  expect(f.executor.restart).not.toHaveBeenCalled();
});

test("running journal survives reload as recovery required without execution", async () => {
  const f = fixture();
  const job = await f.prepare();
  f.journal.write([{ ...job, status: "running", stage: "dispatch_pending" }]);
  const resumed = new InstallationRestarts(f.journal, f.executor);
  await resumed.drain();
  expect(resumed.listBrokers()[0]?.stage).toBe("recovery_required");
  expect(f.install).not.toHaveBeenCalled();
});

test("compatibility is rechecked after approval", async () => {
  const f = fixture();
  const job = await f.prepare();
  f.queue.decideBroker(decision(job));
  f.executor.brokerCompatible = async () => false;
  await f.queue.drain();
  expect(f.queue.listBrokers()[0]?.status).toBe("failed");
  expect(f.install).not.toHaveBeenCalled();
});

// The real Host settings journal requires POSIX directory fsync. Pure workflow
// cases above remain portable and continue running on Windows.
const posixTest = test.skipIf(process.platform === "win32");
posixTest(
  "real HTTP routes isolate Host request access from owner-only exact buttons",
  async () => {
    const { mkdtemp, rm, writeFile, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createHash } = await import("node:crypto");
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "monitor-http-")));
    await writeFile(path.join(dir, "index.html"), "<html><head></head></html>");
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    const installationId = randomUUID();
    const install = vi.fn(async () => "verified monitor");
    const config: import("./config.js").InstallationConfig = {
      public: {
        version: 1,
        installationId,
        origin: "https://owner.example.test",
        environments: [
          { kind: "host", serverId: "host", endpoint: "host.example.test", useTls: true },
          { kind: "container", serverId: "dev", endpoint: "dev.example.test", useTls: true },
        ],
      },
      listenPort: 6770,
      webDistDir: dir,
      stateDir: dir,
      ownerPasswordHash: hashDaemonPassword("owner"),
      hostAgentTokenHash: digest("host"),
      containerAgentTokenHash: digest("guest"),
      host: {
        endpoint: "127.0.0.1:6771",
        password: "host-pass",
        launchdService: "gui/501/local.vorteo.test.host",
      },
      container: { endpoint: "127.0.0.1:6768", password: "dev-pass" },
    };
    const app = createInstallationServer(
      config,
      {
        restart: async () => {
          throw Error("No daemon restart");
        },
        brokerCompatible: async () => true,
        validateBrokerPlan: async () => {},
        installBroker: install,
      },
      pino({ level: "silent" }),
    );
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => listener.once("listening", r));
    const address = listener.address();
    if (!address || typeof address === "string") throw Error("Missing test address");
    config.listenPort = address.port;
    const request = (
      route: string,
      token?: string,
      body?: unknown,
      origin = `http://127.0.0.1:${address.port}`,
    ) =>
      fetch(`http://127.0.0.1:${address.port}/api/installation/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          origin,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      const probe = compatibilityProbe(installationId);
      const input = { id: probe.id, reason: "Broker trust migration", plan: probe.plan };
      expect((await request("broker-rebind-requests", "guest", input)).status).toBe(401);
      expect((await request("owner/broker-rebinds/query", "host", {})).status).toBe(401);
      const deploymentDecision = {
        operation: "preview-broker-consumer-deployment",
        id: randomUUID(),
        revision: randomUUID(),
        planSha256: "a".repeat(64),
        decision: "approve",
      };
      expect(
        (await request("owner/broker-deployments/decision", "host", deploymentDecision)).status,
      ).toBe(401);
      expect(
        (
          await request(
            "owner/broker-deployments/decision",
            "owner",
            deploymentDecision,
            "https://foreign.example.test",
          )
        ).status,
      ).toBe(403);
      const missingDeployment = await request(
        "owner/broker-deployments/decision",
        "owner",
        deploymentDecision,
      );
      expect(missingDeployment.status).toBe(409);
      expect(await missingDeployment.json()).toEqual({
        error: "Deployment request is not retained",
      });
      const capability = await (await request("capabilities", "host")).json();
      expect(capability.previewBroker).toEqual({ available: true, ownerApprovalRequired: true });
      const guestCapability = await (await request("capabilities", "guest")).json();
      expect(guestCapability.previewBroker.available).toBe(false);
      const submitted = await request("broker-rebind-requests", "host", input);
      expect(submitted.status).toBe(201);
      const job = (await submitted.json()) as PreviewBrokerJob;
      expect(job.stage).toBe("prepared");
      const summary = await (await request("restart-summary")).json();
      expect(summary.previewBroker.requested).toBe(1);
      expect(summary).not.toHaveProperty("jobs");
      expect((await request(`broker-rebind-requests/${job.id}`, "guest")).status).toBe(401);
      expect((await request("owner/broker-rebinds/decision", "host", decision(job))).status).toBe(
        401,
      );
      expect(
        (
          await request(
            "owner/broker-rebinds/decision",
            "owner",
            decision(job),
            "https://foreign.example.test",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request("owner/broker-rebinds/decision", "owner", {
            ...decision(job),
            revision: randomUUID(),
          })
        ).status,
      ).toBe(409);
      expect(install).not.toHaveBeenCalled();
      const approved = await request("owner/broker-rebinds/decision", "owner", decision(job));
      expect(approved.status).toBe(200);
      await app.drainRestarts();
      expect(install).toHaveBeenCalledTimes(1);
      expect(
        (await (await request(`broker-rebind-requests/${job.id}`, "host")).json()).status,
      ).toBe("succeeded");
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      await rm(dir, { recursive: true, force: true });
    }
  },
);
