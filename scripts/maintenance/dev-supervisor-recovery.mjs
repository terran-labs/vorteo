// Protected Dev supervisor recovery plan for `container.supervisorMaintenance`.
//
// The coordinator evaluates the exact reviewed bytes of a prepared copy once per
// approved tracked request, as `node --input-type=module --eval <bytes>`, with
// VORTEO_RESTART_JOB_ID set. The plan recovers one failure: the supervisord
// `paseo` program is FATAL, or its worker cannot start, because a Dev source
// activation selected a release that does not start. It selects the previous
// retained release named by the protected Host receipts, starts `paseo` if
// needed, then verifies a replacement worker on that release and container
// health. It never restarts other programs or the container, never replays a
// recorded attempt and never reads or writes Factory state.
//
// Prepare a protected copy with:
//   node scripts/maintenance/dev-supervisor-recovery.mjs prepare \
//     --targets <targets.json> --node <host-node> --output <protected-copy.mjs>
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = /* VORTEO_DEV_SUPERVISOR_TARGETS */ null;

export const PROGRAM = "paseo";
const WORKER_ENTRY = "packages/server/dist/server/server/daemon-worker.js";
const RELEASE_SOURCE = ".installation-source.json";
const SUPERVISOR_MARKER = "managed-supervisor.json";
const PROGRAM_STATES = new Set([
  "STOPPED",
  "STARTING",
  "RUNNING",
  "BACKOFF",
  "STOPPING",
  "EXITED",
  "FATAL",
  "UNKNOWN",
]);
const TARGET_KEYS = [
  "version",
  "installationId",
  "configurationFile",
  "docker",
  "containerId",
  "serviceUser",
  "containerNode",
  "paseoHome",
  "releaseRoot",
  "currentReleaseLink",
  "supervisorctl",
  "supervisordConfig",
  "program",
  "receiptFile",
  "stateDirectory",
  "evidenceDirectory",
];
const TIMING = {
  settleMs: 60_000,
  stableWorkerMs: 15_000,
  verifyMs: 150_000,
  pollMs: 3_000,
};

/** Refused before any effect. Nothing changed. */
export class RecoveryRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "RecoveryRefused";
  }
}

/** Failed after an effect. The evidence record names what changed. */
export class RecoveryFailed extends Error {
  constructor(message, { phase }) {
    super(message);
    this.name = "RecoveryFailed";
    this.phase = phase;
  }
}

function refuse(condition, message) {
  if (!condition) throw new RecoveryRefused(message);
}

const absolute = (value) =>
  typeof value === "string" && path.posix.isAbsolute(value) && !value.includes("\0");

export function validateTargets(targets) {
  refuse(
    targets !== null && typeof targets === "object",
    "This plan copy is unprepared: it carries no installation targets. Prepare a protected copy with `prepare`.",
  );
  const keys = Object.keys(targets).sort();
  refuse(
    JSON.stringify(keys) === JSON.stringify([...TARGET_KEYS].sort()),
    `Plan targets must name exactly: ${TARGET_KEYS.join(", ")}`,
  );
  refuse(targets.version === 1, "Unsupported plan target version");
  refuse(
    typeof targets.installationId === "string" && targets.installationId.length > 0,
    "Plan targets need the installation ID",
  );
  refuse(/^[a-f0-9]{64}$/.test(targets.containerId), "Plan targets need the full Dev container ID");
  refuse(/^[a-z_][a-z0-9_-]*$/.test(targets.serviceUser), "Invalid Dev service user");
  refuse(targets.program === PROGRAM, `This plan only recovers the supervisord ${PROGRAM} program`);
  for (const key of [
    "configurationFile",
    "docker",
    "containerNode",
    "paseoHome",
    "releaseRoot",
    "currentReleaseLink",
    "supervisorctl",
    "supervisordConfig",
    "receiptFile",
    "stateDirectory",
    "evidenceDirectory",
  ])
    refuse(absolute(targets[key]), `Plan target ${key} must be an absolute path`);
  refuse(
    path.posix.dirname(targets.currentReleaseLink) === targets.releaseRoot,
    "The managed release link must be directly inside the release root",
  );
  return targets;
}

/** The live coordinator configuration must name the same installation targets. */
export function assertConfiguredTargets(targets, configuration) {
  const updates = configuration?.containerSourceUpdates;
  refuse(
    configuration?.public?.installationId === targets.installationId,
    "Coordinator installation differs from this plan",
  );
  refuse(
    updates &&
      updates.docker === targets.docker &&
      updates.containerId === targets.containerId &&
      updates.user === targets.serviceUser &&
      updates.node === targets.containerNode &&
      updates.home === targets.paseoHome &&
      updates.releaseRoot === targets.releaseRoot &&
      updates.currentReleaseLink === targets.currentReleaseLink &&
      updates.receiptFile === targets.receiptFile,
    "Coordinator Dev source update targets differ from this plan",
  );
  refuse(
    configuration.stateDir === targets.stateDirectory,
    "Coordinator state differs from this plan",
  );
  refuse(
    configuration.container?.supervisorMaintenance !== undefined,
    "Coordinator has no configured supervisor maintenance plan",
  );
  refuse(
    configuration.container?.persistentRegistration === undefined,
    "Dev registration requires its own bound supervisor operation",
  );
}

export function parseProgramStatus(output, program) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.split(/\s+/)[0] === program);
  refuse(
    lines.length === 1,
    `Supervisord did not report exactly one ${program} program. Supervisord itself may be down; this plan does not restart the container.`,
  );
  const [, state, detail = ""] = lines[0].match(/^\S+\s+(\S+)\s*(.*)$/) ?? [];
  refuse(PROGRAM_STATES.has(state), `Unrecognized ${program} program state`);
  return { state, detail };
}

/**
 * Decides the one recovery this plan may make, or refuses. The previous retained
 * release is the protected installation receipt's release, and a selected
 * release other than it must be the candidate of a failed activation whose
 * recorded previous release is that same receipt. Paths never come from Dev.
 */
export function decideRecovery({
  program,
  selected,
  receipt,
  activations,
  releases,
  workerStable,
}) {
  const previous = receipt.release;
  const retained = releases[previous];
  refuse(
    retained?.withinRoot === true &&
      retained.worker === true &&
      retained.source?.sourceCommit === receipt.sourceCommit &&
      retained.source?.sha256 === receipt.sha256,
    "The previous retained release differs from its protected receipt or lacks its worker. Nothing was changed.",
  );
  const failed = activations.filter(
    (activation) =>
      activation.status === "activating" &&
      activation.previous === previous &&
      activation.release !== previous,
  );
  const recoverable = ["FATAL", "RUNNING"];
  refuse(
    recoverable.includes(program.state),
    `The ${PROGRAM} program is ${program.state}. This plan only recovers a FATAL program or a worker that cannot start; nothing was changed.`,
  );
  if (selected === previous) {
    refuse(
      program.state === "FATAL",
      workerStable
        ? "Dev is already running the previous retained release. Nothing to recover."
        : "The previous retained release's worker does not start. No earlier verified release is recorded; inspect the supervisor log. Nothing was changed.",
    );
    refuse(
      failed.length > 0,
      `The ${PROGRAM} program is FATAL on the verified release without a recorded failed activation. Inspect the supervisor log; nothing was changed.`,
    );
    return { select: null, start: true, release: previous, failedJobs: failed.map((a) => a.jobId) };
  }
  const matching = failed.filter((activation) => activation.release === selected);
  refuse(
    matching.length === 1,
    "The selected release is not a failed activation recorded against the previous retained release. Nothing was changed.",
  );
  refuse(
    program.state === "FATAL" || !workerStable,
    "Dev is running a worker on the selected release. Nothing to recover.",
  );
  return {
    select: { from: selected, to: previous },
    start: program.state === "FATAL",
    release: previous,
    failedJobs: [matching[0].jobId],
  };
}

/** A worker of the marker's supervisor on `release`, unchanged across observations. */
export function stableWorker({ observations, release, minimumMs }) {
  const matching = (observation) => {
    const { supervisor } = observation;
    if (!supervisor?.alive || !supervisor.ownsSelection) return [];
    return observation.workers.filter(
      (worker) =>
        worker.ppid === supervisor.pid &&
        worker.release === release &&
        worker.exe === observation.node,
    );
  };
  const last = observations.at(-1);
  if (!last) return null;
  const [worker] = matching(last);
  if (!worker || matching(last).length !== 1) return null;
  const since = observations.find((observation) =>
    matching(observation).some(
      (candidate) =>
        candidate.pid === worker.pid && observation.supervisor.pid === last.supervisor.pid,
    ),
  );
  const unbroken = observations
    .slice(observations.indexOf(since))
    .every((observation) =>
      matching(observation).some((candidate) => candidate.pid === worker.pid),
    );
  if (!unbroken || last.at - since.at < minimumMs) return null;
  return { pid: worker.pid, supervisorPid: last.supervisor.pid };
}

export function containerHealth(inspection, targets) {
  refuse(inspection?.Id === targets.containerId, "Docker reports a different Dev container");
  refuse(inspection.State?.Running === true, "The Dev container is not running");
  return {
    startedAt: inspection.State.StartedAt,
    health: inspection.State.Health?.Status ?? null,
  };
}

/**
 * Runs inside the Dev container as the service user. Its source is part of the
 * reviewed plan bytes; it receives only paths from the protected targets.
 */
export function containerHelper(input, { files, paths, procRoot }) {
  const attempt = (read, fallback) => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  const text = (file) => attempt(() => files.readFileSync(file, "utf8"), null);
  const root = files.realpathSync(input.releaseRoot);
  const link = input.currentReleaseLink;
  if (paths.dirname(link) !== root) throw new Error("Managed release link escaped its root");
  const selected = () => files.realpathSync(link);
  const canonical = (release) => {
    const resolved = files.realpathSync(release);
    return resolved === release && resolved.startsWith(root + paths.sep) ? resolved : null;
  };
  const describe = (release) => {
    const source = attempt(() => JSON.parse(text(paths.join(release, input.releaseSource))), null);
    return {
      withinRoot: attempt(() => canonical(release) !== null, false),
      worker: attempt(() => files.statSync(paths.join(release, input.workerEntry)).isFile(), false),
      source: source && { sourceCommit: source.sourceCommit, sha256: source.sha256 },
    };
  };
  const supervisor = () => {
    const marker = attempt(() => JSON.parse(text(paths.join(input.home, input.marker))), null);
    const valid =
      marker?.version === 1 &&
      marker.link === link &&
      marker.root === root &&
      Number.isSafeInteger(marker.pid) &&
      marker.pid > 0;
    if (!valid) return null;
    const environ = text(paths.join(procRoot, String(marker.pid), "environ"));
    const variables = (environ ?? "").split("\0");
    return {
      pid: marker.pid,
      alive: environ !== null,
      ownsSelection:
        variables.includes(`PASEO_MANAGED_RELEASE_LINK=${link}`) &&
        variables.includes(`PASEO_MANAGED_RELEASE_ROOT=${input.releaseRoot}`),
    };
  };
  const worker = (name, parent) => {
    const ppid = Number(text(paths.join(procRoot, name, "status"))?.match(/^PPid:\s+(\d+)$/m)?.[1]);
    if (ppid !== parent) return null;
    const command = (text(paths.join(procRoot, name, "cmdline")) ?? "").split("\0");
    const entry = command.find((argument) => argument.endsWith(`/${input.workerEntry}`));
    if (!entry) return null;
    return {
      pid: Number(name),
      ppid,
      exe: attempt(() => files.realpathSync(paths.join(procRoot, name, "exe")), null),
      release: entry.slice(0, -(input.workerEntry.length + 1)),
    };
  };
  const observe = () => {
    const owner = supervisor();
    const workers = owner?.alive
      ? files
          .readdirSync(procRoot)
          .filter((name) => /^\d+$/.test(name))
          .map((name) => worker(name, owner.pid))
          .filter(Boolean)
      : [];
    return {
      selected: selected(),
      node: files.realpathSync(input.node),
      supervisor: owner,
      workers,
    };
  };
  if (input.action === "inspect")
    return {
      root,
      ...observe(),
      releases: Object.fromEntries(input.releases.map((release) => [release, describe(release)])),
    };
  if (input.action === "observe") return observe();
  if (input.action !== "select") throw new Error("Unknown recovery helper action");
  if (selected() !== input.from) throw new Error("Release selection changed; nothing selected");
  const target = canonical(input.to);
  if (!target) throw new Error("Previous release escaped the managed root");
  const temporary = `${link}.${input.jobId}.recovery`;
  files.symlinkSync(target, temporary);
  files.renameSync(temporary, link);
  if (selected() !== target) throw new Error("Release selection did not take effect");
  return { selected: selected() };
}

export const CONTAINER_HELPER_SOURCE = `import fs from "node:fs";
import path from "node:path";
const helper = ${containerHelper.toString()};
const input = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(helper(input, { files: fs, paths: path, procRoot: "/proc" })));
`;

function helperInput(targets, extra) {
  return {
    releaseRoot: targets.releaseRoot,
    currentReleaseLink: targets.currentReleaseLink,
    home: targets.paseoHome,
    node: targets.containerNode,
    marker: SUPERVISOR_MARKER,
    workerEntry: WORKER_ENTRY,
    releaseSource: RELEASE_SOURCE,
    ...extra,
  };
}

function readActivations(targets, io) {
  const directory = path.join(targets.stateDirectory, "container-source-updates");
  const activations = [];
  for (const jobId of io.listDirectory(directory)) {
    const file = path.join(directory, jobId, "activation.json");
    if (!io.exists(file)) continue;
    const record = JSON.parse(io.readText(file));
    activations.push({
      jobId,
      status: record.status,
      release: record.release,
      previous: record.previous,
    });
  }
  return activations;
}

function assertPrivateDirectory(directory, io) {
  const stat = io.stat(directory);
  refuse(
    stat.isDirectory && stat.uid === io.uid && (stat.mode & 0o077) === 0,
    "The recovery evidence directory must be an owner-only directory of the coordinator user",
  );
}

/** Refuses while an earlier attempt has no recorded outcome. */
function assertNoUnsettledAttempt(evidenceDirectory, io) {
  for (const name of io.listDirectory(evidenceDirectory)) {
    const attempt = path.join(evidenceDirectory, name);
    if (!io.exists(path.join(attempt, "intent.json"))) continue;
    refuse(
      io.exists(path.join(attempt, "result.json")),
      `Earlier recovery ${name} has no recorded outcome. Inspect ${attempt}, reconcile Dev, then move that record out of the evidence directory before a new request.`,
    );
  }
}

export function rollbackProcedure({ targets, from, to }) {
  return [
    `This recovery changed only ${targets.currentReleaseLink} from ${from} to ${to}, and started the supervisord ${PROGRAM} program when it was FATAL.`,
    `Both releases stay retained; nothing was deleted. Host receipts, the coordinator journal and Factory state were not modified.`,
    `To undo the selection, through a new reviewed operation: as user ${targets.serviceUser} in container ${targets.containerId}, create a symlink to ${from} beside the link and rename it over ${targets.currentReleaseLink}, then request a tracked Dev restart.`,
  ];
}

async function dockerJson(io, args, label) {
  const result = await io.docker(args);
  if (result.code !== 0)
    throw new RecoveryRefused(`${label} failed: ${result.stderr.trim().slice(0, 300)}`);
  return JSON.parse(result.stdout);
}

function helperArgs(targets, input) {
  return [
    "exec",
    "--user",
    targets.serviceUser,
    targets.containerId,
    targets.containerNode,
    "--input-type=module",
    "--eval",
    CONTAINER_HELPER_SOURCE,
    JSON.stringify(input),
  ];
}

function supervisorctlArgs(targets, command) {
  return [
    "exec",
    "--user",
    "root",
    targets.containerId,
    targets.supervisorctl,
    "-c",
    targets.supervisordConfig,
    command,
    targets.program,
  ];
}

async function programStatus(targets, io) {
  const result = await io.docker(supervisorctlArgs(targets, "status"));
  return parseProgramStatus(result.stdout, targets.program);
}

async function inspectContainer(targets, io) {
  const [inspection] = await dockerJson(
    io,
    ["inspect", "--type", "container", targets.containerId],
    "Docker inspection",
  );
  return containerHealth(inspection, targets);
}

/** Observes the worker on `release` long enough to call it stable, or until `deadline`. */
async function watchWorker({ targets, io, release, deadline }) {
  const observations = [];
  for (;;) {
    const observation = await dockerJson(
      io,
      helperArgs(targets, helperInput(targets, { action: "observe" })),
      "Dev release observation",
    );
    observations.push({ ...observation, at: io.now() });
    const worker = stableWorker({ observations, release, minimumMs: TIMING.stableWorkerMs });
    if (worker) return { worker, observation };
    if (io.now() + TIMING.pollMs > deadline) return { worker: null, observation };
    await io.sleep(TIMING.pollMs);
  }
}

async function settledProgram(targets, io) {
  let program = await programStatus(targets, io);
  const settleBy = io.now() + TIMING.settleMs;
  while (["STARTING", "BACKOFF"].includes(program.state) && io.now() < settleBy) {
    await io.sleep(TIMING.pollMs);
    program = await programStatus(targets, io);
  }
  return program;
}

/** Observes Dev and decides without effects. Refusals here change nothing. */
async function preflight(targets, io) {
  const container = await inspectContainer(targets, io);
  const program = await settledProgram(targets, io);
  const receipt = JSON.parse(io.readText(targets.receiptFile));
  refuse(absolute(receipt.release), "The protected installation receipt names no release");
  const activations = readActivations(targets, io);
  const candidates = [
    ...new Set([receipt.release, ...activations.flatMap((a) => [a.release, a.previous])]),
  ].filter(absolute);
  const inspection = await dockerJson(
    io,
    helperArgs(targets, helperInput(targets, { action: "inspect", releases: candidates })),
    "Dev release inspection",
  );
  let workerStable = false;
  if (program.state === "RUNNING") {
    const { worker } = await watchWorker({
      targets,
      io,
      release: inspection.selected,
      deadline: io.now() + TIMING.stableWorkerMs + TIMING.pollMs * 2,
    });
    workerStable = worker !== null;
  }
  const decision = decideRecovery({
    program,
    selected: inspection.selected,
    receipt,
    activations,
    releases: inspection.releases,
    workerStable,
  });
  return {
    container,
    program,
    selected: inspection.selected,
    supervisor: inspection.supervisor,
    decision,
  };
}

async function healthyContainer(targets, io, deadline) {
  let container = await inspectContainer(targets, io);
  while (container.health !== null && container.health !== "healthy" && io.now() < deadline) {
    await io.sleep(TIMING.pollMs);
    container = await inspectContainer(targets, io);
  }
  return container;
}

/** Requires a stable replacement worker on the selected release and a healthy container. */
async function verifyRecovery({ targets, io, before }) {
  const phase = "verify";
  const { decision } = before;
  const deadline = io.now() + TIMING.verifyMs;
  const { worker, observation } = await watchWorker({
    targets,
    io,
    release: decision.release,
    deadline,
  });
  if (!worker)
    throw new RecoveryFailed(
      `No stable worker started on the previous retained release ${decision.release}`,
      { phase },
    );
  const previousSupervisorAlive =
    before.supervisor?.alive === true && before.supervisor.pid === worker.supervisorPid;
  if (decision.start && previousSupervisorAlive)
    throw new RecoveryFailed("The supervisor was not replaced by the started program", { phase });
  const program = await programStatus(targets, io);
  if (program.state !== "RUNNING")
    throw new RecoveryFailed(`The ${targets.program} program is ${program.state} after recovery`, {
      phase,
    });
  const container = await healthyContainer(targets, io, deadline);
  if (container.startedAt !== before.container.startedAt)
    throw new RecoveryFailed("The Dev container restarted during recovery", { phase });
  if (container.health !== null && container.health !== "healthy")
    throw new RecoveryFailed(`The Dev container is ${container.health} after recovery`, { phase });
  if (observation.selected !== decision.release)
    throw new RecoveryFailed("The release selection changed during verification", { phase });
  return { worker, program, container };
}

export async function recoverDevSupervisor({ targets: rawTargets, env, io }) {
  const targets = validateTargets(rawTargets);
  const jobId = env.VORTEO_RESTART_JOB_ID;
  refuse(
    typeof jobId === "string" && /^[a-f0-9-]{36}$/.test(jobId),
    "Run this plan only through an approved tracked supervisor maintenance request",
  );
  assertConfiguredTargets(targets, JSON.parse(io.readText(targets.configurationFile)));
  assertPrivateDirectory(targets.evidenceDirectory, io);
  assertNoUnsettledAttempt(targets.evidenceDirectory, io);
  const record = path.join(targets.evidenceDirectory, jobId);
  // Exclusive creation: a request ID that already ran is never replayed.
  io.makePrivateDirectory(record);
  io.writePrivateFile(path.join(record, "intent.json"), {
    jobId,
    startedAt: new Date(io.now()).toISOString(),
    targets,
  });
  const writeResult = (result) =>
    io.writePrivateFile(path.join(record, "result.json"), {
      ...result,
      finishedAt: new Date(io.now()).toISOString(),
    });
  let phase = "preflight";
  try {
    const before = await preflight(targets, io);
    const { decision } = before;
    io.writePrivateFile(path.join(record, "rollback.json"), {
      jobId,
      link: targets.currentReleaseLink,
      from: before.selected,
      to: decision.release,
      procedure: rollbackProcedure({ targets, from: before.selected, to: decision.release }),
    });
    if (decision.select) {
      phase = "select";
      await dockerJson(
        io,
        helperArgs(targets, helperInput(targets, { action: "select", jobId, ...decision.select })),
        "Release selection",
      );
    }
    if (decision.start) {
      phase = "start";
      const started = await io.docker(supervisorctlArgs(targets, "start"));
      if (started.code !== 0 || !/\bstarted\b/.test(started.stdout))
        throw new RecoveryFailed(
          `supervisorctl could not start ${targets.program}: ${(started.stdout + started.stderr).trim().slice(0, 300)}`,
          { phase },
        );
    }
    phase = "verify";
    const after = await verifyRecovery({ targets, io, before });
    writeResult({ status: "verified", before, ...after });
    return `Dev supervisor recovered on previous retained release ${decision.release}: worker ${after.worker.pid}, supervisor ${after.worker.supervisorPid}, container ${after.container.health ?? "running"}. Evidence ${record}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "preflight") {
      writeResult({ status: "refused", phase, message });
      throw error;
    }
    writeResult({ status: "failed", phase, message });
    throw new RecoveryFailed(
      `${message}. Recovery stopped during ${phase} and is not retried. See ${path.join(record, "rollback.json")}.`,
      { phase },
    );
  }
}

function exitCode(error) {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : 1;
}

function hostIo(targets) {
  return {
    uid: process.getuid(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exists: (file) => fs.existsSync(file),
    readText: (file) => fs.readFileSync(file, "utf8"),
    listDirectory: (directory) =>
      fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [],
    stat(file) {
      const stat = fs.lstatSync(file);
      return { isDirectory: stat.isDirectory(), uid: stat.uid, mode: stat.mode };
    },
    makePrivateDirectory: (directory) => fs.mkdirSync(directory, { mode: 0o700 }),
    writePrivateFile(file, value) {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    docker: (args) =>
      new Promise((resolve) => {
        execFile(
          targets.docker,
          args,
          { timeout: 60_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => resolve({ code: exitCode(error), stdout, stderr }),
        );
      }),
  };
}

/** Embeds validated targets into a protected copy and reports its configuration value. */
export function preparePlan({ source, targets, node, output }) {
  validateTargets(targets);
  refuse(absolute(node) && absolute(output), "Prepare needs absolute --node and --output paths");
  // Built from parts so this line never matches the marker it replaces.
  const marker = ["/* VORTEO_DEV_SUPERVISOR_TARGETS */", "null"].join(" ");
  refuse(source.split(marker).length === 2, "Plan source lacks its single targets marker");
  const prepared = source.replace(
    marker,
    `/* VORTEO_DEV_SUPERVISOR_TARGETS */ ${JSON.stringify(targets)}`,
  );
  return {
    prepared,
    value: { node, script: output, sha256: createHash("sha256").update(prepared).digest("hex") },
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  refuse(index >= 0 && args[index + 1], `Missing ${name}`);
  return args[index + 1];
}

async function main() {
  // An evaluated plan has no script path; the coordinator passes only its bytes.
  if (process.argv.length === 1 && /\/\[eval\d*\]$/.test(import.meta.url)) {
    try {
      const summary = await recoverDevSupervisor({
        targets: TARGETS,
        env: process.env,
        io: hostIo(validateTargets(TARGETS)),
      });
      process.stdout.write(`${summary}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`.slice(0, 4000),
      );
      process.exitCode = 1;
    }
    return;
  }
  const self = fileURLToPath(import.meta.url);
  if (!process.argv[1] || fs.realpathSync(process.argv[1]) !== fs.realpathSync(self)) return;
  const args = process.argv.slice(2);
  refuse(
    args[0] === "prepare",
    "Usage: dev-supervisor-recovery.mjs prepare --targets <file> --node <path> --output <path>",
  );
  const output = option(args, "--output");
  const { prepared, value } = preparePlan({
    source: fs.readFileSync(self, "utf8"),
    targets: JSON.parse(fs.readFileSync(option(args, "--targets"), "utf8")),
    node: option(args, "--node"),
    output,
  });
  fs.writeFileSync(output, prepared, { mode: 0o400, flag: "wx" });
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

await main();
