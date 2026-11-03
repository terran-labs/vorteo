import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  PreviewBrokerPlanSchema,
  PreviewBrokerObservationSchema,
  type PreviewBrokerJob,
  type PreviewBrokerPlan,
} from "@getpaseo/protocol/preview-broker-maintenance";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import { InstallationConfigSchema, type InstallationConfig } from "./config.js";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import { InstallationRestarts } from "./restarts.js";
import { monitorCommand, verifyExecutable } from "./preview-monitor-executor.js";

interface BrokerContext {
  config: InstallationConfig;
  writableMountRoots(): Promise<readonly string[]>;
}
interface BrokerTools {
  command: typeof monitorCommand;
  verifyExecutable?: typeof verifyExecutable;
}

/** No generic argv, installer, service control or automatic delegation is exposed. */
export function createPreviewBrokerExecutor(
  context: BrokerContext,
  tools: BrokerTools = { command: monitorCommand },
) {
  const configuration = context.config.previewBroker;
  if (!configuration) throw new Error("Broker maintenance is not configured");
  const config = configuration;
  async function protectedInputs() {
    const roots = await context.writableMountRoots();
    const read = (file: { path: string; sha256: string }) => readBootstrapPreparedFile(file, roots);
    const worker = await read(config.worker);
    const identity = await read(config.identityModule);
    const executable = tools.verifyExecutable ?? verifyExecutable;
    await executable(config.python, roots);
    await executable(config.recovery.node, roots);
    for (const file of [
      config.recovery.journal,
      config.recovery.queue,
      config.recovery.configModule,
    ])
      await read(file);
    const expected = config.configPaths.flatMap((file) =>
      ["https_broker.py", "channel_identity.py", "host_config.py", "https-preview.py"].map((name) =>
        path.join(path.dirname(file), name),
      ),
    );
    if (
      new Set(config.configPaths).size !== 2 ||
      config.consumerFiles.length !== expected.length ||
      new Set(config.consumerFiles.map((file) => file.path)).size !== expected.length
    )
      throw new Error("Broker consumer scope is incomplete or duplicated");
    for (const file of config.consumerFiles) {
      if (!expected.includes(file.path)) throw new Error("Foreign broker consumer");
      if (
        path.basename(file.path) === "channel_identity.py" &&
        file.sha256 !== config.identityModule.sha256
      )
        throw new Error("Consumer identity verifier differs from executor");
      await read(file);
    }
    return { roots, worker, identity };
  }
  async function invoke(operation: "inspect" | "apply" | "observe", plan: PreviewBrokerPlan) {
    const { worker, identity } = await protectedInputs();
    // Pinned source bytes are loaded in isolated modules. No path-based Python import
    // from the writable request channel or checkout is permitted.
    const program = `import sys,types\nm=types.ModuleType('channel_identity')\nexec(compile(${JSON.stringify(identity.toString("utf8"))},'<pinned-channel-identity>','exec'),m.__dict__)\nsys.modules['channel_identity']=m\nexec(compile(${JSON.stringify(worker.toString("utf8"))},'<pinned-broker-worker>','exec'))\ncoordinator_main()\n`;
    const output = await tools.command({
      executable: config.python.path,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", NODE_OPTIONS: "" },
      args: ["-I", "-B", "-c", program],
      input: JSON.stringify({
        operation,
        plan,
        allowedConfigs: config.configPaths,
        evidenceRoot: config.evidenceRoot,
        ...(operation === "observe"
          ? {
              approvedPlanBytes: JSON.stringify(plan),
              approvedPlanSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
            }
          : {}),
      }),
    });
    await protectedInputs();
    return JSON.parse(output) as {
      ready?: boolean;
      status?: string;
      candidateHashes?: string[];
      serviceStarted?: boolean;
    };
  }
  async function brokerCompatible(): Promise<boolean> {
    try {
      await protectedInputs();
      const probe = compatibilityProbe(context.config.public.installationId);
      InstallationConfigSchema.parse(context.config);
      const records = parseLifecycleJournal([probe]);
      const queue = new InstallationRestarts(
        {
          read: () => records,
          write: () => {
            throw Error("probe cannot write");
          },
        },
        {
          restart: async () => {
            throw Error("probe cannot dispatch");
          },
        },
        Date.now,
        {},
        { fenced: true },
      );
      if (queue.listBrokers().length !== 1 || queue.list().length !== 0) return false;
      const program = `import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));const j=await import(${JSON.stringify(config.recovery.journal.path)});const q=await import(${JSON.stringify(config.recovery.queue.path)});const c=await import(${JSON.stringify(config.recovery.configModule.path)});c.InstallationConfigSchema.parse(input.config);const jobs=j.parseLifecycleJournal(input.jobs);const queue=new q.InstallationRestarts({read:()=>jobs,write:()=>{throw Error('probe cannot write');}},{restart:async()=>{throw Error('probe cannot dispatch');}},Date.now,{}, {fenced:true});if(queue.listBrokers().length!==1||queue.list().length!==0)throw Error('incompatible');process.stdout.write('broker-journal-config-v1');`;
      const result = await tools.command({
        executable: config.recovery.node.path,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", NODE_OPTIONS: "" },
        args: ["--input-type=module", "-e", program],
        input: JSON.stringify({ config: context.config, jobs: [probe] }),
      });
      await protectedInputs();
      return result === "broker-journal-config-v1";
    } catch {
      return false;
    }
  }
  async function validateBrokerPlan(input: PreviewBrokerPlan): Promise<void> {
    const plan = PreviewBrokerPlanSchema.parse(input);
    if (
      plan.evidenceDirectory !== path.join(config.evidenceRoot, plan.id) ||
      plan.brokers.some(
        (item) =>
          item.fencePath !==
          path.join(path.dirname(item.configPath), "https-broker-rebind.pending.json"),
      )
    )
      throw new Error("Broker evidence or fence footprint changed");
    if (plan.installationId !== context.config.public.installationId)
      throw new Error("Broker plan belongs to another installation");
    if (
      plan.brokers.some((item) => !config.configPaths.includes(item.configPath)) ||
      new Set(plan.brokers.map((item) => item.configPath)).size !== 2
    )
      throw new Error("Broker config scope changed");
    if (!(await brokerCompatible()))
      throw new Error(
        "Broker requires compatible selected and recovery config and journal readers",
      );
    const roots = await context.writableMountRoots();
    for (const evidence of plan.continuityEvidence)
      await readBootstrapPreparedFile(evidence, roots);
    const result = await invoke("inspect", plan);
    if (result.ready !== true) throw new Error("Broker migration preflight refused");
  }
  async function installBroker(job: PreviewBrokerJob): Promise<string> {
    if (
      job.status !== "running" ||
      job.stage !== "dispatch_pending" ||
      job.id !== job.plan.id ||
      !job.approvedAt ||
      createHash("sha256").update(JSON.stringify(job.plan)).digest("hex") !== job.planSha256
    )
      throw new Error("Broker dispatch does not bind the approved plan");
    const result = await invoke("apply", job.plan);
    if (
      result.status !== "succeeded" ||
      result.serviceStarted !== false ||
      JSON.stringify(result.candidateHashes) !==
        JSON.stringify(job.plan.brokers.map((item) => item.candidateSha256))
    )
      throw new Error("Broker result uncertain; preserve evidence without replay");
    return "Both broker configs verified. Consumers reload under their lock on the next invocation. No service was started.";
  }
  async function observeBrokerOutcome(job: PreviewBrokerJob) {
    if (
      !job.approvedAt ||
      job.id !== job.plan.id ||
      job.planSha256 !== createHash("sha256").update(JSON.stringify(job.plan)).digest("hex") ||
      job.plan.installationId !== context.config.public.installationId ||
      job.plan.evidenceDirectory !== path.join(config.evidenceRoot, job.id)
    )
      throw new Error("Broker observation does not bind an approved effect");
    if (!(await brokerCompatible())) throw new Error("Broker observation reader is incompatible");
    const observation = PreviewBrokerObservationSchema.parse(await invoke("observe", job.plan));
    if (observation.id !== job.id || observation.planSha256 !== job.planSha256)
      throw new Error("Broker observation changed approved identity");
    return observation;
  }
  return { brokerCompatible, validateBrokerPlan, installBroker, observeBrokerOutcome };
}

export function compatibilityProbe(installationId: string): PreviewBrokerJob {
  const id = randomUUID();
  const directory = { inode: 1, uid: 501, gid: 20, mode: 0o700 };
  const broker = (name: string) => ({
    configPath: `/protected/${name}/host-config.json`,
    fencePath: `/protected/${name}/https-broker-rebind.pending.json`,
    expectedSha256: "a".repeat(64),
    candidateSha256: "b".repeat(64),
    anchor: {
      version: 1 as const,
      filesystem: "apfs" as const,
      volumeUUID: "7785796d-d4b1-445a-a2ad-b673a4dd6683",
      mountPoint: "/System/Volumes/Data",
      ancestors: { "/": directory },
      directories: { "": directory, inbox: directory, receipts: directory, origins: directory },
    },
  });
  const plan = PreviewBrokerPlanSchema.parse({
    version: 1,
    operation: "preview-broker-channel-rebind",
    id,
    installationId,
    sourceCommit: "c".repeat(40),
    evidenceDirectory: `/protected/evidence/${id}`,
    continuityEvidence: [{ path: "/protected/continuity.json", sha256: "d".repeat(64) }],
    brokers: [broker("native"), broker("dev")],
  });
  return {
    target: "preview-broker",
    operation: plan.operation,
    id,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Read-only compatibility probe",
    createdAt: "2026-01-01T00:00:00.000Z",
    plan,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    status: "pending",
    stage: "prepared",
    detail: "Probe only",
    observation: {
      kind: "committed",
      id,
      planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      workerPlanSha256: "d".repeat(64),
      commitSha256: "e".repeat(64),
      configSelections: ["candidate", "candidate"],
      inventorySha256: ["a".repeat(64), "b".repeat(64)],
      reason: "commit-confirmed",
    },
  };
}
