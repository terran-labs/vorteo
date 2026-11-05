import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import {
  BrokerDeploymentScopeSchema,
  PreviewBrokerDeploymentPlanSchema,
  PreviewBrokerDeploymentObservationSchema,
  type PreviewBrokerDeploymentJob,
  type PreviewBrokerDeploymentPlan,
} from "@getpaseo/protocol/preview-broker-deployment";
import {
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { monitorCommand, verifyExecutable } from "./preview-monitor-executor.js";
import { InstallationConfigSchema, type InstallationConfig } from "./config.js";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import type { BrokerDeploymentExecutor } from "./preview-broker-deployment-workflow.js";

const digest = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const moduleNames = [
  "channel_identity",
  "broker_rebind",
  "broker_deployment",
  "broker_deployment_kernel",
  "broker_deployment_observation",
] as const;
interface Context {
  config: InstallationConfig;
  configurationFile: { path: string; sha256: string };
  assertActive(): void;
  writableMountRoots(): Promise<readonly string[]>;
}

/** Fixed native operation. Production assembly never supplies permissive test ports. */
export function createPreviewBrokerDeploymentExecutor(context: Context): BrokerDeploymentExecutor {
  const config = context.config.previewBrokerDeployment;
  if (!config) throw Error("Broker consumer deployment is not configured");
  const configuration = config;
  function assertPlanScope(
    plan: PreviewBrokerDeploymentPlan,
    scope: z.infer<typeof BrokerDeploymentScopeSchema>,
  ) {
    if (
      plan.installationId !== scope.installationId ||
      plan.id !== scope.requestId ||
      plan.bootUUID.toLowerCase() !== scope.bootUUID.toLowerCase() ||
      JSON.stringify(plan.manualParticipants) !== JSON.stringify(scope.manualParticipants) ||
      JSON.stringify(plan.participantEvidence) !== JSON.stringify([configuration.scope]) ||
      plan.evidenceDirectory !== path.join(configuration.evidenceRoot, plan.id) ||
      JSON.stringify(plan.targets.map((target) => target.root)) !==
        JSON.stringify(configuration.roots) ||
      JSON.stringify(configuration.bindings.map((binding) => binding.root)) !==
        JSON.stringify(configuration.roots)
    )
      throw Error("Deployment scope differs from protected participant custody");
  }
  async function protectedInputs(plan?: PreviewBrokerDeploymentPlan, recovery = false) {
    context.assertActive();
    const roots = await context.writableMountRoots();
    const read = (pin: { path: string; sha256: string }) => readBootstrapPreparedFile(pin, roots);
    await read(context.configurationFile);
    await verifyExecutable(configuration.python, roots);
    await verifyExecutable(configuration.recovery.node, roots);
    await read(configuration.nativeInspector);
    for (const pin of [
      configuration.recovery.journal,
      configuration.recovery.queue,
      configuration.recovery.configModule,
    ])
      await read(pin);
    if (configuration.modules.length !== moduleNames.length)
      throw Error("Incomplete deployment module closure");
    const modules: Array<[string, string]> = [];
    for (const name of moduleNames) {
      const matches = configuration.modules.filter(
        (pin) => path.basename(pin.path) === `${name}.py`,
      );
      if (matches.length !== 1) throw Error("Deployment module closure changed");
      modules.push([name, (await read(matches[0]!)).toString("utf8")]);
    }
    const worker = (await read(configuration.worker)).toString("utf8");
    const scope = BrokerDeploymentScopeSchema.parse(
      JSON.parse((await read(configuration.scope)).toString("utf8")),
    );
    if (
      scope.installationId !== context.config.public.installationId ||
      JSON.stringify(scope.bindings) !== JSON.stringify(configuration.bindings)
    )
      throw Error("Protected participant scope differs from configured routes");
    if (!recovery && Date.parse(scope.validUntil) <= Date.now() + 180_000)
      throw Error("Participant commitment does not cover the bounded execution");
    for (const binding of configuration.bindings) await read(binding.plist);
    if (plan) {
      assertPlanScope(plan, scope);
      await assertBootstrapPathsProtected([plan.evidenceDirectory], roots);
      await verifyEvidenceDirectory(plan);
      for (const target of plan.targets)
        for (const file of Object.values(target.files)) await read(file.candidate);
    }
    context.assertActive();
    return { roots, scope, worker, modules };
  }

  async function verifyEvidenceDirectory(plan: PreviewBrokerDeploymentPlan) {
    const info = await lstat(plan.evidenceDirectory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(plan.evidenceDirectory)) !== plan.evidenceDirectory ||
      JSON.stringify([info.dev, info.ino, info.uid, info.gid, info.mode & 0o777]) !==
        JSON.stringify(plan.evidenceDirectoryIdentity)
    )
      throw Error("Prepared evidence directory identity changed");
  }
  async function writeOnce(plan: PreviewBrokerDeploymentPlan, name: string, value: unknown) {
    await verifyEvidenceDirectory(plan);
    const directory = plan.evidenceDirectory;
    const descriptor = await open(path.join(directory, name), "wx", 0o600);
    try {
      await descriptor.writeFile(JSON.stringify(value) + "\n");
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  async function invoke(
    operation: "inspect" | "execute" | "observe",
    plan: PreviewBrokerDeploymentPlan,
    assertReservation: () => void,
    job?: PreviewBrokerDeploymentJob,
  ) {
    assertReservation();
    const prepared = await protectedInputs(plan, operation === "observe");
    assertReservation();
    const reader = await createNativeBootstrapServiceReader({
      helperPath: configuration.nativeInspector.path,
      helperSha256: configuration.nativeInspector.sha256,
      writableMountRoots: prepared.roots,
    });
    assertReservation();
    const session = randomUUID();
    const planSha256 = digest(JSON.stringify(plan));
    const program =
      "import sys,types\n" +
      prepared.modules
        .map(
          ([name, source]) =>
            `m=types.ModuleType(${JSON.stringify(name)})\nsys.modules[${JSON.stringify(name)}]=m\nexec(compile(${JSON.stringify(source)},${JSON.stringify(`<pinned-${name}>`)},'exec'),m.__dict__)\n`,
        )
        .join("") +
      `exec(compile(${JSON.stringify(prepared.worker)},'<pinned-deployment-worker>','exec'))\ncoordinator_main()\n`;
    if (operation === "execute") {
      if (
        !job ||
        job.status !== "running" ||
        job.stage !== "dispatch_pending" ||
        !job.approvedAt ||
        job.planSha256 !== planSha256
      )
        throw Error("Exact approved deployment dispatch required");
      await writeOnce(plan, "child-intent.json", {
        id: job.id,
        revision: job.revision,
        planSha256,
        session,
      });
      assertReservation();
    }
    const deadline = Date.now() + 120_000;
    const child = spawn(configuration.python.path, ["-I", "-B", "-c", program], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const channel = child.stdio[3] as Duplex;
    let output = "";
    let errors = "";
    let pending = "";
    let sequence = 0;
    let failure: unknown;
    let serial = Promise.resolve();
    let rejectCompletion: (error: unknown) => void = () => {};
    const fail = (error: unknown) => {
      failure ??= error;
      channel.destroy();
      child.stdin.destroy();
      rejectCompletion(failure);
    };
    const timer = setTimeout(
      () => fail(Error("Deployment child deadline expired; retain uncertainty")),
      120_000,
    );
    // Only the child owns native command completion. Timeout closes admission; it
    // never kills/replays a child whose last effect may have completed.
    const completed = new Promise<string>((resolve, reject) => {
      rejectCompletion = reject;
      child.once("error", fail);
      child.stdout.on("data", (raw: Buffer) => {
        output += raw.toString("utf8");
        if (output.length > 1024 * 1024) fail(Error("Deployment output exceeds bound"));
      });
      child.stderr.on("data", (raw: Buffer) => {
        errors += raw.toString("utf8");
        if (errors.length > 65536) fail(Error("Deployment diagnostics exceed bound"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        channel.destroy();
        void serial.then(() => {
          if (failure || Date.now() >= deadline || code !== 0 || errors)
            reject(failure ?? Error("Deployment native outcome uncertain"));
          else resolve(output);
          return;
        }, reject);
      });
    });
    // The first private-channel request waits for independently observed child custody.
    let identity: Awaited<ReturnType<typeof reader.inspectRunningProcess>>;
    const custody = (async () => {
      if (!child.pid) throw Error("Deployment child has no native identity");
      identity = await reader.inspectRunningProcess(child.pid);
      assertReservation();
      if (
        identity.pid !== child.pid ||
        identity.parentPid !== process.pid ||
        identity.uid !== process.getuid?.() ||
        identity.bootId.toLowerCase() !== plan.bootUUID.toLowerCase() ||
        identity.executable !== configuration.python.path ||
        identity.argumentsSha256 !==
          digest(JSON.stringify([configuration.python.path, "-I", "-B", "-c", program]))
      )
        throw Error("Deployment child custody differs");
      if (operation === "execute")
        await writeOnce(plan, "child-spawned.json", {
          session,
          planSha256,
          identity,
        });
    })();
    void custody.catch(fail);
    channel.on("error", fail);
    channel.on("data", (raw: Buffer) => {
      pending += raw.toString("utf8");
      if (pending.length > 4096) {
        fail(Error("Oversized deployment guard message"));
        return;
      }
      const end = pending.indexOf("\n");
      if (end < 0) return;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      serial = serial
        .then(async () => {
          await custody;
          if (failure || Date.now() >= deadline) throw Error("Deployment admission expired");
          const message = z
            .strictObject({
              session: z.literal(session),
              sequence: z.number().int().positive(),
              operation: z.literal("guard"),
            })
            .parse(JSON.parse(line));
          if (message.sequence !== ++sequence || pending)
            throw Error("Deployment guard sequence changed");
          assertReservation();
          await protectedInputs(plan, operation === "observe");
          const current = await reader.inspectRunningProcess(child.pid!);
          if (JSON.stringify(current) !== JSON.stringify(identity))
            throw Error("Deployment child identity changed");
          assertReservation();
          if (failure || Date.now() >= deadline) throw Error("Deployment admission expired");
          channel.write(JSON.stringify({ ...message, admitted: true }) + "\n");
          return;
        })
        .catch(fail);
    });
    child.stdin.on("error", fail);
    child.stdin.end(
      JSON.stringify({ operation, plan, planSha256, bindings: configuration.bindings, session }),
    );
    const result = JSON.parse(await completed) as unknown;
    assertReservation();
    await protectedInputs(plan, operation === "observe");
    assertReservation();
    return result;
  }

  async function brokerDeploymentCompatible() {
    try {
      const { scope } = await protectedInputs();
      InstallationConfigSchema.parse(context.config);
      // Ask the retained reader to parse the new target and configuration before
      // any real record is appended. No native process or effect is invoked.
      const file = { path: "/probe", sha256: "a".repeat(64) };
      const consumer = {
        expected: { kind: "present", sha256: file.sha256, identity: Array(9).fill("1") },
        candidate: file,
        mode: 0o600,
      };
      const plan = PreviewBrokerDeploymentPlanSchema.parse({
        version: 1,
        operation: "preview-broker-consumer-deployment",
        id: scope.requestId,
        installationId: scope.installationId,
        sourceCommit: "a".repeat(40),
        bootUUID: scope.bootUUID,
        evidenceDirectory: path.join(configuration.evidenceRoot, scope.requestId),
        evidenceDirectoryIdentity: [1, 2, 501, 20, 0o700],
        targets: configuration.roots.map((root) => ({
          root,
          directory: [1, 2, 501, 20, 448],
          preservationSha256: file.sha256,
          files: {
            "https_broker.py": consumer,
            "https-preview.py": consumer,
            "host_config.py": consumer,
            "channel_identity.py": { ...consumer, expected: { kind: "absent" } },
          },
        })),
        registrations: configuration.bindings.map((binding) => ({
          root: binding.root,
          domain: binding.domain,
          label: binding.label,
          plist: binding.plist,
          disposition: "absent",
          process: null,
          enabled: true,
          override: "absent",
        })),
        participantEvidence: [configuration.scope],
        manualParticipants: scope.manualParticipants,
      });
      const probe = {
        target: "preview-broker-deployment",
        operation: plan.operation,
        id: plan.id,
        revision: randomUUID(),
        requestedBy: "host-agent",
        reason: "Reader compatibility probe",
        createdAt: new Date().toISOString(),
        plan,
        planSha256: digest(JSON.stringify(plan)),
        status: "failed",
        stage: "recovery_required",
        detail: "Probe only",
      };
      parseLifecycleJournal([probe]);
      const script = `import fs from 'node:fs';const p=JSON.parse(fs.readFileSync(0,'utf8'));const j=await import(${JSON.stringify(configuration.recovery.journal.path)});const c=await import(${JSON.stringify(configuration.recovery.configModule.path)});const q=await import(${JSON.stringify(configuration.recovery.queue.path)});c.InstallationConfigSchema.parse(p.config);const records=j.parseLifecycleJournal(p.jobs);const queue=new q.InstallationRestarts({read:()=>records,write:()=>{throw Error('probe write refused')}},{restart:async()=>{throw Error('probe effect refused')}},Date.now,{}, {fenced:true});if(queue.listBrokerDeployments().length!==1)throw Error('reader mismatch');process.stdout.write('deployment-reader-v1');`;
      const result = await monitorCommand({
        executable: configuration.recovery.node.path,
        args: ["--input-type=module", "-e", script],
        env: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "" },
        input: JSON.stringify({ config: context.config, jobs: [probe] }),
      });
      await protectedInputs();
      return result === "deployment-reader-v1";
    } catch {
      return false;
    }
  }
  return {
    brokerDeploymentCompatible,
    async validateBrokerDeploymentPlan(plan) {
      const parsed = PreviewBrokerDeploymentPlanSchema.parse(plan);
      const result = z.strictObject({ prepared: z.literal(true) });
      result.parse(await invoke("inspect", parsed, context.assertActive));
    },
    async executeBrokerDeployment(job, assertReservation) {
      return PreviewBrokerDeploymentObservationSchema.parse(
        await invoke("execute", job.plan, assertReservation, job),
      );
    },
    async observeBrokerDeployment(job) {
      return PreviewBrokerDeploymentObservationSchema.parse(
        await invoke("observe", job.plan, context.assertActive),
      );
    },
  };
}
