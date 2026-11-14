import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { openBootstrapRequests } from "../coordinator-bootstrap.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { retainMaintenancePublishedFile } from "../coordinator-bootstrap-maintenance-file-selection.js";
import {
  withHostContinuationAdmission,
  type FileEnrollmentJournal,
  type HostContinuationConsumption,
  type EnrollmentWriteFiles,
} from "./authorization.js";
import { writeInitialHostArtifact } from "./host-supervisor-migration.js";
import { retainBinding } from "./host-supervisor-continuation.js";

const operationSchema = z.enum(["interruption", "retirement", "bootstrap"]);
type Operation = z.infer<typeof operationSchema>;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Captured protected dispatch evidence, not delivery or reusable authority. */
export const HostContinuationCommandQueueAttemptSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("host-continuation-command-queue-attempt"),
  command: operationSchema,
  role: z.enum(["restoration", "candidate"]),
  stepId: z.uuid(),
  generation: z.uuid(),
  reservationSha256: digestSchema,
  intentSha256: digestSchema,
  claimSha256: digestSchema,
  executor: BootstrapProcessIdentitySchema,
  scope: z.strictObject({
    identitySha256: digestSchema,
    artifactSha256: digestSchema,
    preconditionSha256: digestSchema,
  }),
  fenceSha256: digestSchema,
  commandSha256: digestSchema,
  channelSha256: digestSchema,
});

/** Produced by the independently verified native command owner, never parsed
 * from an HTTP request. The assertion must bind the actual retained channel,
 * fixed command and original native executor, including boot and birth. This
 * helper supplies no such producer and no default command implementation. */
export interface HostContinuationCommandOwner {
  operation: Operation;
  executor: z.infer<typeof BootstrapProcessIdentitySchema>;
  /** Actual immutable data used by the native owner's fixed enqueue operation. */
  command: object;
  /** Actual live handle retained by that owner, not a serialized capability. */
  channel: object;
  /** Independently measured native identity of that same live channel. */
  channelIdentity: object;
  scope: {
    identitySha256: string;
    artifactSha256: string;
    preconditionSha256: string;
  };
  fence: { file: string; bytes: Uint8Array };
  assertCurrent(): void;
  /** Synchronous one-use queue call only. Completion is observed separately. */
  enqueue(): void;
}

function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(`Host command attempt: ${message}`);
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function synchronous(callback: () => void) {
  const result: unknown = callback();
  requireProof(result === undefined, "custody and enqueue must complete synchronously");
}

/** Preserve the publisher's canonical field order for read-only collectors.
 * This data-only builder establishes no custody, admission or native facts. */
export function hostContinuationCommandQueueAttemptRecord(input: {
  consumption: HostContinuationConsumption;
  operation: Operation;
  executor: HostContinuationCommandOwner["executor"];
  scope: HostContinuationCommandOwner["scope"];
  fenceBytes: Uint8Array;
  command: object;
  channelIdentity: object;
}) {
  return {
    version: 1 as const,
    operation: "host-continuation-command-queue-attempt" as const,
    command: input.operation,
    role: input.consumption.role,
    stepId: input.consumption.stepId,
    generation: input.consumption.generation,
    reservationSha256: input.consumption.reservationSha256,
    intentSha256: input.consumption.intentSha256,
    claimSha256: input.consumption.claimSha256,
    executor: input.executor,
    scope: input.scope,
    fenceSha256: createHash("sha256").update(input.fenceBytes).digest("hex"),
    commandSha256: digest(input.command),
    channelSha256: digest(input.channelIdentity),
  };
}

/** One addressed attempt for one already-consumed child operation. The native
 * owner calls this at its actual queue boundary. Two locked transactions keep
 * the durable attempt before queueing; every reconstruction meets O_EXCL.
 *
 * A return proves only that the synchronous enqueue call returned. Throws,
 * partial writes, lost replies and later fsync failure never permit replay.
 * No native wait or completion occurs while lifecycle admission is held. */
export function attemptHostContinuationCommand(
  journal: FileEnrollmentJournal,
  consumption: HostContinuationConsumption,
  owner: HostContinuationCommandOwner,
  files?: Pick<EnrollmentWriteFiles, "open" | "write" | "sync" | "close">,
): void {
  const retained = retainBinding(consumption);
  const operation = operationSchema.parse(owner.operation);
  const role = z.enum(["restoration", "candidate"]).parse(consumption.role);
  const writes = files && { ...files };
  requireProof(
    role === "candidate" || operation === "bootstrap",
    "operation is not permitted for the consumed role",
  );
  const executor = BootstrapProcessIdentitySchema.parse(owner.executor);
  requireProof(
    isDeepStrictEqual(executor, consumption.executor) &&
      executor.pid === process.pid &&
      executor.parentPid === process.ppid &&
      executor.uid === process.getuid?.() &&
      executor.executable === realpathSync(process.execPath),
    "only the original consumed native executor may attempt a command",
  );
  const native = retainBinding({
    executor: owner.executor,
    command: owner.command,
    channelIdentity: owner.channelIdentity,
    scope: owner.scope,
    fence: owner.fence,
  });
  const command = owner.command,
    channel = owner.channel,
    channelIdentity = owner.channelIdentity,
    scope = owner.scope,
    fence = owner.fence,
    nativeExecutor = owner.executor,
    assertNative = owner.assertCurrent,
    enqueue = owner.enqueue;
  requireProof(
    command !== null &&
      channel !== null &&
      typeof channel === "object" &&
      typeof assertNative === "function" &&
      typeof enqueue === "function",
    "retained native command and channel are required",
  );
  // Reject callbacks, accessors and non-JSON command/identity payloads. Live
  // channel objects are deliberately retained by reference instead of cloned.
  z.json().parse(native.snapshot.command);
  z.json().parse(native.snapshot.channelIdentity);
  const prefix = path.join(
    journal.stateDirectory,
    `host-continuation-${z.uuid().parse(consumption.stepId)}-${role}-${z.uuid().parse(consumption.generation)}`,
  );
  requireProof(
    fence.file === `${prefix}-${operation}-attempt.json`,
    "command fence is misaddressed",
  );
  const fenceBytes = Buffer.from(native.snapshot.fence.bytes);
  const fenceRecord = z
    .object({
      version: z.literal(1),
      role: z.literal(role),
      stepId: z.literal(consumption.stepId),
      generation: z.literal(consumption.generation),
      reservationSha256: z.literal(consumption.reservationSha256),
      intentSha256: z.literal(consumption.intentSha256),
      claimSha256: z.literal(consumption.claimSha256),
      planSha256: z.string().regex(/^[a-f0-9]{64}$/),
      operation: z.literal(operation),
    })
    .parse(JSON.parse(fenceBytes.toString("utf8")));
  const retainFenceParents = retainServiceFiles([journal.stateDirectory, fence.file]);
  const retainFence = retainMaintenancePublishedFile(fence.file, fenceBytes);
  const assertReferences = () => {
    retained.check();
    native.check();
    requireProof(
      executor.pid === process.pid &&
        executor.parentPid === process.ppid &&
        executor.uid === process.getuid?.() &&
        executor.executable === realpathSync(process.execPath) &&
        owner.operation === operation &&
        owner.executor === nativeExecutor &&
        owner.command === command &&
        owner.channel === channel &&
        owner.channelIdentity === channelIdentity &&
        owner.scope === scope &&
        owner.fence === fence &&
        owner.assertCurrent === assertNative &&
        owner.enqueue === enqueue,
      "native command owner binding changed",
    );
  };
  const check = () => {
    assertReferences();
    retainFenceParents();
    retainFence();
    assertAttempt?.();
    synchronous(() => assertNative.call(owner));
    assertReferences();
    retainFenceParents();
    retainFence();
    assertAttempt?.();
  };
  const input = retained.snapshot;
  const originalCurrent = input.assertCurrent,
    originalExclusive = input.assertExclusive;
  const admission: HostContinuationConsumption = {
    ...input,
    assertCurrent(context) {
      check();
      synchronous(() => originalCurrent.call(consumption, context));
      check();
    },
    assertExclusive(context) {
      check();
      synchronous(() => originalExclusive.call(consumption, context));
      check();
    },
  };
  const attemptFile = `${prefix}-${operation}-queue-attempt.json`;
  let assertAttempt: (() => void) | undefined;
  withHostContinuationAdmission(journal, admission, (context, reassert) => {
    requireProof(
      fenceRecord.planSha256 === context.lineage.binding.planSha256,
      "fence plan differs",
    );
    const target =
      role === "candidate" && operation === "bootstrap"
        ? context.plan.candidate
        : context.plan.fallback;
    requireProof(
      isDeepStrictEqual(native.snapshot.scope, {
        identitySha256: context.lineage.binding.identitySha256,
        artifactSha256: target.artifactSha256,
        preconditionSha256:
          role === "candidate"
            ? context.lineage.candidate!.evidence.preconditionSha256
            : context.plan.preconditionSha256,
      }),
      "native command target differs from consumed operation",
    );
    reassert();
    const record = hostContinuationCommandQueueAttemptRecord({
      consumption,
      operation,
      executor,
      scope: native.snapshot.scope,
      fenceBytes,
      command: native.snapshot.command,
      channelIdentity: native.snapshot.channelIdentity,
    });
    writeInitialHostArtifact(journal.stateDirectory, attemptFile, record, writes);
    assertAttempt = retainMaintenancePublishedFile(
      attemptFile,
      Buffer.from(JSON.stringify(record)),
    );
    reassert();
    assertAttempt();
  });
  requireProof(assertAttempt, "durable command attempt is unavailable");
  const retainedAttempt = assertAttempt;
  // Once the attempt exists, ANY failed admission leaves it consumed. No
  // exception path removes it or rebuilds a callable capability from its bytes.
  withHostContinuationAdmission(journal, admission, (_context, reassert) => {
    // This is the LAST callback-bearing check. It performs native/file custody
    // and then rereads current policy under the lifecycle lock.
    reassert();
    // No supplied callback may run between that policy read and enqueue.
    retainFenceParents();
    retainFence();
    retainedAttempt();
    synchronous(() => Reflect.apply(enqueue, owner, []));
    assertReferences();
    retainedAttempt();
  });
}

/** Live fixed-command owner for ordinary cooperative preparation. It is not an
 * activation/candidate continuation owner and cannot execute their operations. */
const cooperativeCommandOwners = new WeakMap<object, { enqueue(): void }>();

export interface CooperativeMailboxCommandOwner {
  readonly reservation: import("@getpaseo/protocol/maintenance-interruption").CooperativeDrainPreparation;
  assertCurrent(): void;
  close(): void;
  observed: Promise<"published" | "unknown">;
}

export function cooperativeCommandDigest(value: unknown): string {
  function canonical(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input !== null && typeof input === "object") {
      const item = input as Record<string, unknown>;
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
        .join(",")}}`;
    }
    const encoded = JSON.stringify(input);
    if (encoded === undefined) throw new Error("Cooperative data must be JSON");
    return encoded;
  }
  return createHash("sha256")
    .update(canonical(JSON.parse(JSON.stringify(value))))
    .digest("hex");
}

/** Spawns only the fixed helper with its stdin still closed to commands. Native
 * policy admission and the durable attempt must precede enqueue(). */
export async function prepareCooperativeMailboxCommand(input: {
  config: import("../config.js").InstallationConfig;
  native: import("./native-daemon-inspection.js").EnrollmentDaemonObservation;
  reservation: import("@getpaseo/protocol/maintenance-interruption").CooperativeDrainPreparation;
}): Promise<CooperativeMailboxCommandOwner> {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { BootstrapAdmissionSetupSchema, readPrivateBootstrapConfiguration } =
    await import("../coordinator-bootstrap-host.js");
  const endpoint = input.native.descriptor.cooperativeMailbox;
  if (!endpoint || endpoint.endpointIdentitySha256 !== input.reservation.endpointIdentitySha256)
    throw new Error("Native cooperative endpoint is unavailable for the exact phase");
  input.native.assertCurrent();
  const sourcePath = fileURLToPath(
    new URL("../../../../scripts/cooperative-drain-mailbox.py", import.meta.url),
  );
  const sourceFile = await fs.promises.open(
    sourcePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let source: Buffer;
  try {
    const info = await sourceFile.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 32768 || (info.mode & 0o022) !== 0)
      throw new Error("Packaged cooperative helper custody is unavailable");
    source = await sourceFile.readFile();
    if (createHash("sha256").update(source).digest("hex") !== endpoint.helperSha256)
      throw new Error("Packaged cooperative helper differs from the enrolled target helper");
  } finally {
    await sourceFile.close();
  }
  const fixedArgs = [
    "-I",
    "-B",
    "-c",
    source.toString("utf8"),
    "publish",
    "--scope",
    endpoint.scopeFile,
    "--endpoint-sha256",
    endpoint.endpointIdentitySha256,
    "--owner-uid",
    String(endpoint.ownerUid),
  ];
  let executable: string = endpoint.pythonFile;
  let args: string[] = fixedArgs;
  if (input.native.descriptor.environment === "container") {
    const settings = input.config.containerSourceUpdates;
    const root = input.native.descriptor.installationRoot;
    const runner = z
      .object({ admissionSetupFile: z.string().startsWith("/") })
      .parse(
        readPrivateBootstrapConfiguration(
          path.join(root, "coordinator-bootstrap-runner.json"),
          input.native.descriptor.custodyOwnerUid,
        ),
      );
    const setup = BootstrapAdmissionSetupSchema.parse(
      readPrivateBootstrapConfiguration(
        runner.admissionSetupFile,
        input.native.descriptor.custodyOwnerUid,
      ),
    );
    if (
      !settings ||
      settings.containerId !== input.native.descriptor.containerId ||
      setup.containerId !== settings.containerId ||
      setup.docker !== settings.docker ||
      endpoint.ownerUid !== 0 ||
      endpoint.readerUid !== input.native.descriptor.containerUid
    )
      throw new Error("Cooperative producer differs from the registered Dev native target");
    executable = setup.docker;
    args = [
      "--host",
      `unix://${setup.socket}`,
      "exec",
      "--interactive",
      "--user",
      "0",
      setup.containerId,
      endpoint.pythonFile,
      ...fixedArgs,
    ];
  } else if (
    endpoint.ownerUid !== process.getuid?.() ||
    endpoint.readerUid !== process.getuid?.()
  ) {
    throw new Error("Cooperative producer differs from the enrolled Host owner");
  }
  const reservation = structuredClone(input.reservation);
  const reservationDigest = cooperativeCommandDigest(reservation);
  const command = Buffer.from(
    JSON.stringify({
      operation: "maintenance.interrupt-held-turns",
      endpointIdentitySha256: endpoint.endpointIdentitySha256,
      reservationSha256: cooperativeCommandDigest(reservation),
      reservation,
    }),
  );
  if (command.length > 32768) throw new Error("Cooperative command exceeds its byte budget");
  input.native.assertCurrent();
  const child = spawn(executable, args, {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  const stdin = child.stdin;
  const end = stdin.end;
  let consumed = false;
  let output = "";
  const observed = new Promise<"published" | "unknown">((resolve) => {
    child.on("error", () => resolve("unknown"));
    stdin.on("error", () => resolve("unknown"));
    child.stdout.on("data", (data: Buffer) => {
      if (Buffer.byteLength(output) + data.length > 4096) {
        resolve("unknown");
        return;
      }
      output += data.toString("utf8");
    });
    child.stderr.resume();
    child.on("close", (code) => {
      try {
        const reply = JSON.parse(output);
        resolve(
          code === 0 &&
            reply.state === "published" &&
            reply.generation === reservation.intent.held.generation
            ? "published"
            : "unknown",
        );
      } catch {
        resolve("unknown");
      }
    });
  });
  // Closing an unused input cannot publish a command; it is not a daemon action.
  const timeout = setTimeout(() => {
    stdin.destroy();
  }, 5000);
  timeout.unref();
  void observed.finally(() => clearTimeout(timeout));
  const assertCurrent = () => {
    input.native.assertCurrent();
    if (
      consumed ||
      !child.pid ||
      cooperativeCommandDigest(reservation) !== reservationDigest ||
      child.stdin !== stdin ||
      stdin.end !== end ||
      stdin.destroyed ||
      child.exitCode !== null ||
      reservation.intent.held.terminateAt <= Date.now()
    )
      throw new Error("Cooperative native command handle is no longer current");
  };
  const owner: CooperativeMailboxCommandOwner = Object.freeze({
    reservation,
    assertCurrent,
    close() {
      if (!consumed) stdin.destroy();
    },
    observed,
  });
  // The returned observation handle cannot enqueue. Only locked admission in
  // this module can reach the actual retained pipe's one-use operation.
  cooperativeCommandOwners.set(owner, {
    enqueue() {
      if (consumed || stdin.destroyed || child.exitCode !== null)
        throw new Error("Cooperative native generation was already attempted");
      consumed = true;
      Reflect.apply(end, stdin, [command]);
    },
  });
  return owner;
}

/** Two locked transactions: durable accepted phase, then an exclusive attempt
 * and synchronous enqueue on the already-open actual native command pipe. */
export function attemptCooperativeMailboxCommand(input: {
  directory: string;
  job: import("@getpaseo/protocol/execution-installation").RestartJob;
  owner: CooperativeMailboxCommandOwner;
  validate(job: import("@getpaseo/protocol/execution-installation").RestartJob): void;
}): void {
  const command = cooperativeCommandOwners.get(input.owner);
  if (!command)
    throw new Error("Cooperative dispatch requires the actual retained native command owner");
  const journal = new FileBootstrapRequestJournal(input.directory);
  const owner = input.owner;
  const requestId = z.uuid().parse(input.job.id);
  const generation = z.uuid().parse(owner.reservation.intent.held.generation);
  const expected = cooperativeCommandDigest(owner.reservation);
  const retainedJob = (jobs: readonly import("../lifecycle-journal.js").LifecycleJob[]) => {
    const job = jobs.find((candidate) => candidate.id === requestId);
    if (
      !job ||
      (job.target !== "host" && job.target !== "container-daemon") ||
      job.status !== "approved" ||
      job.revision !== input.job.revision ||
      !job.cooperativeDrainPreparation ||
      cooperativeCommandDigest({
        ...job.cooperativeDrainPreparation,
        phase: "reserved",
        observation: undefined,
      }) !== expected
    )
      throw new Error("Cooperative request or reserved generation changed before dispatch");
    return job;
  };
  journal.mutateLifecycle(
    (jobs) => {
      const job = retainedJob(jobs);
      if (job.cooperativeDrainPreparation!.phase !== "reserved")
        throw new Error("Cooperative generation is observation-only; never enqueue again");
      return jobs.map((candidate) =>
        candidate.id === requestId
          ? {
              ...job,
              cooperativeDrainPreparation: {
                ...job.cooperativeDrainPreparation!,
                phase: "accepted",
              },
            }
          : candidate,
      );
    },
    (_previous, next) => {
      owner.assertCurrent();
      input.validate(retainedJob(next));
      return undefined;
    },
  );
  journal.mutateLifecycle(
    (jobs) => [...jobs],
    (_previous, next) => {
      const job = retainedJob(next);
      if (job.cooperativeDrainPreparation!.phase !== "accepted")
        throw new Error("Cooperative generation was no longer accepted");
      owner.assertCurrent();
      // mutateLifecycle checks generic work admission after its callback. This
      // callback owns an effect, so inspect coordinator exclusion before enqueue
      // under the same already-held lock rather than relying on that later gate.
      if (openBootstrapRequests(journal.read()).some((request) => request.execution))
        throw new Error("Coordinator recovery must finish before cooperative dispatch");
      // validate must finish its native checks before its final locked policy
      // reread. No callback-bearing checks may follow this decision.
      input.validate(job);
      writeInitialHostArtifact(
        input.directory,
        // This fence survives an older journal reader dropping the private phase.
        // A new generation for the same request must not recreate dispatch.
        path.join(input.directory, `cooperative-${requestId}-attempt.json`),
        {
          operation: "maintenance.interrupt-held-turns",
          requestId,
          generation,
          reservationSha256: expected,
          revision: job.revision,
        },
      );
      command.enqueue();
      return undefined;
    },
  );
}
