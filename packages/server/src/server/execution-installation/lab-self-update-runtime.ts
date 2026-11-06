import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { LabUpdate, LabUpdateStatus } from "@getpaseo/protocol/lab-self-update";
import type { InstallationConfig } from "./config.js";
import {
  launchHandoff,
  pointLink,
  readCurrentLink,
  readHandoffOutcome,
  type CoordinatorSwapPlan,
} from "./coordinator-handoff.js";
import { removeReleaseTree } from "./host-release-retention.js";
import { reportedInstallationType } from "./installation-type.js";
import {
  createLabUpdateJournal,
  LabSelfUpdates,
  type LabHostRestartState,
  type LabUpdatePorts,
} from "./lab-self-update.js";
import { liveDevPaths } from "./live-dev/supervisor.js";
import { releaseOfEntrypoint } from "./release-upgrade-runtime.js";
import { RestartRequestError, type InstallationRestarts } from "./restarts.js";
import { createServiceControl, managedServices } from "./service-control.js";

const COORDINATOR_READY_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 60 * 60_000;
/** Lab releases kept beyond the selected and previous ones. */
const KEEP_NEWEST_LAB_RELEASES = 3;
const LAB_RELEASE = /^lab-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SUPERVISOR_ENTRYPOINT = "packages/server/dist/scripts/supervisor-entrypoint.js";
const COORDINATOR_ENTRYPOINT = "packages/server/dist/server/server/execution-installation/main.js";
const HANDOFF_HELPER =
  "packages/server/dist/server/server/execution-installation/coordinator-handoff-main.js";
const WEB_DIST = "packages/server/dist/server/web-ui";
/** A live lock directory without an owner record is still being created, unless this old. */
const ORPHAN_LOCK_MS = 10 * 60_000;
/** The installer engine's dependency steps, for a clone whose dependencies are stale. */
const DEPENDENCY_STEPS: Array<[string[], string]> = [
  [["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"], "dependencies.log"],
  [["rebuild", "--foreground-scripts"], "dependency-rebuild.log"],
  [["run", "postinstall"], "dependency-patches.log"],
];
const DEPENDENCY_KEY_SCRIPT =
  "const { dependencyKey } = await import(process.argv[1]); process.stdout.write(dependencyKey(process.cwd(), 'worktree'));";

export interface LabSelfUpdateRuntime {
  updates: LabSelfUpdates;
  /** Why lab self-updates cannot run now, including a Stable type, or null. */
  blocker(): Promise<string | null>;
  status(): Promise<LabUpdateStatus>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Stops a build process group a previous coordinator left behind, by its pidfile. */
async function stopRecordedBuild(pidFile: string): Promise<void> {
  const pid = Number((await readText(pidFile))?.trim());
  if (Number.isInteger(pid) && pid > 1 && alive(pid))
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  await rm(pidFile, { force: true });
}

/**
 * Runs one command in its own process group with output appended to `log` and its PID in
 * `pidFile`. Abort and timeout stop the whole group, so npm's children stop with it.
 * Resolves with standard output.
 */
async function runLogged(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: string;
  pidFile: string;
  signal: AbortSignal;
}): Promise<string> {
  if (input.signal.aborted) throw new Error("Cancelled");
  const log = await open(input.log, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", log.fd],
    });
  } finally {
    await log.close();
  }
  if (child.pid) await writeFile(input.pidFile, `${child.pid}\n`, { mode: 0o600 });
  const stop = () => {
    if (child.pid && child.exitCode === null)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
  };
  const timer = setTimeout(stop, BUILD_TIMEOUT_MS);
  input.signal.addEventListener("abort", stop, { once: true });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 1024 * 1024) output = output.slice(-512 * 1024);
  });
  const exit = await new Promise<{ code: number | null; signal: string | null; error?: Error }>(
    (resolve) => {
      let settled = false;
      const settle = (value: { code: number | null; signal: string | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.on("error", (error) => settle({ code: null, signal: null, error }));
      child.on("close", (code, signal) => settle({ code, signal }));
    },
  );
  clearTimeout(timer);
  input.signal.removeEventListener("abort", stop);
  await rm(input.pidFile, { force: true });
  await writeFile(input.log, output, { flag: "a" }).catch(() => undefined);
  if (exit.error) throw exit.error;
  if (exit.code === 0) return output;
  const outcome = exit.signal ? `stopped (${exit.signal})` : `exited ${exit.code}`;
  throw new Error(
    `${path.basename(input.command)} ${input.args.slice(0, 4).join(" ")} ${outcome}. See ${input.log}.`,
  );
}

/**
 * Holds the live checkout's Git lock, the one scripts/live-dev.mjs `withLock` takes, while
 * `action` runs, so the clone never sees a half-finished promote, sync or commit.
 */
async function withLiveLock<T>(lock: string, action: () => Promise<T>): Promise<T> {
  const staging = `${lock}.${process.pid}.${randomUUID()}`;
  await mkdir(staging);
  await writeFile(
    path.join(staging, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      by: "Lab self-update",
      command: "lab-update",
      at: new Date().toISOString(),
    }),
  );
  let held = false;
  try {
    for (let attempt = 0; attempt < 2 && !held; attempt += 1) {
      try {
        await rename(staging, lock);
        held = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        let owner: { pid?: number; by?: string; command?: string } | null = null;
        try {
          owner = JSON.parse((await readText(path.join(lock, "owner.json"))) ?? "null");
        } catch {
          owner = null;
        }
        const young = !owner && Date.now() - (await stat(lock)).mtimeMs < ORPHAN_LOCK_MS;
        if ((owner?.pid && alive(owner.pid)) || young)
          throw new Error(
            `The live checkout is busy${owner ? `: ${owner.by} is running ${owner.command}` : ""}. Request the lab update again when it finishes.`,
            { cause: error },
          );
        await rename(lock, `${lock}.stale.${randomUUID()}`).catch(() => undefined);
      }
    }
    if (!held) throw new Error("The live checkout is busy.");
    return await action();
  } finally {
    if (held) await rm(lock, { recursive: true, force: true });
    else await rm(staging, { recursive: true, force: true });
  }
}

function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function gitOutput(checkout: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", checkout, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} exited ${code}`));
    });
  });
}

/** Paths with uncommitted changes in `git status --porcelain=v1 -z` output. */
function dirtyPaths(porcelain: string): string[] {
  const entries = porcelain.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    files.push(entry.slice(3));
    // Renames and copies carry the source path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return files;
}

export function createLabSelfUpdateRuntime(input: {
  config: InstallationConfig;
  restarts: InstallationRestarts;
  logger: Logger;
  /** Another lifecycle operation that must finish first, or null. */
  conflict: () => string | null;
  entrypoint?: string;
}): LabSelfUpdateRuntime {
  const { config, restarts, logger } = input;
  const entrypoint = input.entrypoint ?? process.argv[1] ?? "";
  const hostLink = config.deployment?.hostReleaseLink;
  const coordinatorLink = config.deployment?.coordinator?.releaseLink;
  const services = managedServices(config);
  const directory = path.join(config.stateDir, "lab-updates");
  const live = hostLink ? liveDevPaths(hostLink, config.stateDir) : null;
  const hostNode = config.host.startupValidation?.node ?? process.execPath;
  const health = {
    url: `http://127.0.0.1:${config.listenPort}/api/installation/health`,
    installationId: config.public.installationId,
    previousPid: process.pid,
  };

  /** Why this installation's layout cannot self-update, independent of its type. */
  async function layoutBlocker(): Promise<string | null> {
    if (!hostLink || !coordinatorLink || !live)
      return "Lab self-updates need a Host and coordinator installed by the Vorteo installer.";
    // Managed source updates select Host releases through their own link and receipts.
    if (config.sourceUpdates)
      return "Lab self-updates need an installer-made Host; this one installs through Host source updates.";
    if (typeof services === "string") return services;
    if (!(await exists(path.join(live.checkout, "package.json"))))
      return `The live checkout is missing at ${live.checkout}.`;
    try {
      releaseOfEntrypoint(entrypoint);
    } catch {
      return "The coordinator does not run from an installed release.";
    }
    return null;
  }

  async function blocker(): Promise<string | null> {
    const layout = await layoutBlocker();
    if (layout) return layout;
    const type = await reportedInstallationType(config.stateDir);
    if (type.unreadable)
      return "The installation type record is unreadable. Choose Stable or Lab again in Installation settings.";
    if (type.type !== "lab") return "Lab self-updates run only when the installation type is Lab.";
    return null;
  }

  async function inspectSource(): Promise<NonNullable<LabUpdate["source"]>> {
    if (!live) throw new Error("The live checkout is unknown");
    const git = (args: string[]) => gitOutput(live.checkout, args);
    const head = (await git(["rev-parse", "HEAD"]).catch(() => "")).trim();
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
    const files = dirtyPaths(
      await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    );
    let claims: Array<{ by?: string; files?: string[] }> = [];
    try {
      const value = JSON.parse((await readText(path.join(live.root, "claims.json"))) ?? "{}");
      if (Array.isArray(value.claims)) claims = value.claims;
    } catch {
      claims = [];
    }
    return {
      checkout: live.checkout,
      branch: branch || null,
      head: COMMIT.test(head) ? head : null,
      dirty: files.map((file) => ({
        file,
        claimedBy: claims.find((claim) => claim.files?.includes(file))?.by ?? null,
      })),
    };
  }

  /** True when the clone's dependency key matches the one live-dev recorded at its install. */
  async function dependenciesCurrent(
    release: string,
    step: (command: string, args: string[], log: string) => Promise<string>,
  ): Promise<boolean> {
    if (!live || !(await exists(path.join(release, "node_modules")))) return false;
    const preparedKey = (await readText(path.join(live.root, "prepared-key")))?.trim();
    if (!preparedKey) return false;
    const key = await step(
      hostNode,
      [
        "--input-type=module",
        "-e",
        DEPENDENCY_KEY_SCRIPT,
        path.join(release, "scripts/lib/dependency-cache.mjs"),
      ],
      "dependency-key.log",
    );
    return key.trim() === preparedKey;
  }

  async function build(update: LabUpdate, signal: AbortSignal): Promise<string> {
    if (!live || !hostLink || !coordinatorLink)
      throw new Error("The installation layout is unknown");
    const work = path.join(directory, update.id);
    await mkdir(work, { recursive: true, mode: 0o700 });
    const pidFile = path.join(work, "build.pid");
    await stopRecordedBuild(pidFile);
    const releases = path.dirname(hostLink);
    const release = path.join(
      releases,
      `lab-${compactTimestamp(new Date())}-${update.id.slice(0, 8)}`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${path.dirname(hostNode)}:${process.env.PATH ?? ""}`,
      // The server compiler exceeds Node's 2 GiB default on smaller machines.
      NODE_OPTIONS: ["--max-old-space-size=4096", process.env.NODE_OPTIONS]
        .filter(Boolean)
        .join(" "),
    };
    const step = (command: string, args: string[], log: string, cwd = release) =>
      runLogged({ command, args, cwd, env, log: path.join(work, log), pidFile, signal });
    const clone = (from: string, to: string, log: string) =>
      process.platform === "darwin"
        ? step("/bin/cp", ["-c", "-R", from, to], log, releases)
        : step("cp", ["-a", "--reflink=auto", from, to], log, releases);
    try {
      // Copy-on-write: dependencies and earlier build output come along at metadata cost.
      await withLiveLock(path.join(live.root, "lock"), () =>
        clone(live.checkout, release, "clone.log"),
      );
      // The worktree's .git file points at the live checkout's index; never share it.
      await rm(path.join(release, ".git"), { recursive: true, force: true });
      if (!(await dependenciesCurrent(release, step)))
        for (const [args, log] of DEPENDENCY_STEPS)
          await step("/usr/bin/nice", ["-n", "10", "npm", ...args], log);
      await step("/usr/bin/nice", ["-n", "10", "npm", "run", "build:server"], "server-build.log");
      // The interface is already live; keep the static one the coordinator serves now.
      const web = path.join(release, WEB_DIST);
      const currentWeb = path.join(await realpath(coordinatorLink), WEB_DIST);
      if (!(await exists(currentWeb)))
        throw new Error("The installed coordinator release has no static interface to keep.");
      await rm(web, { recursive: true, force: true });
      await clone(currentWeb, web, "web-ui.log");
      for (const file of [SUPERVISOR_ENTRYPOINT, COORDINATOR_ENTRYPOINT])
        if (!(await exists(path.join(release, file))))
          throw new Error(`The build did not produce ${file}.`);
      await writeFile(
        path.join(release, ".installer-release.json"),
        JSON.stringify({
          ...(update.source?.head ? { revision: update.source.head } : {}),
          builtAt: new Date().toISOString(),
          lab: {
            updateId: update.id,
            branch: update.source?.branch ?? null,
            dirty: update.source?.dirty.map((item) => item.file) ?? [],
          },
        }) + "\n",
      );
      logger.info({ updateId: update.id, release }, "Lab self-update release built");
      return await realpath(release);
    } catch (error) {
      await removeReleaseTree(release).catch(() => undefined);
      throw error;
    }
  }

  function hostRestart(jobId: string): LabHostRestartState {
    const job = restarts.list().find((item) => item.id === jobId);
    if (!job) return { status: "failed", detail: "The Host restart request disappeared." };
    if (job.status === "succeeded") return { status: "succeeded", detail: job.detail };
    if (job.status === "failed") return { status: "failed", detail: job.detail };
    if (job.status === "rejected") return { status: "cancelled", detail: job.detail };
    return { status: "running", detail: job.detail };
  }

  async function prune(keep: string[]): Promise<void> {
    if (!hostLink) return;
    const root = path.dirname(hostLink);
    const kept = new Set(await Promise.all(keep.map((item) => realpath(item).catch(() => item))));
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && LAB_RELEASE.test(entry.name))
        .map(async (entry) => {
          const release = path.join(root, entry.name);
          return { release, mtimeMs: (await stat(release)).mtimeMs };
        }),
    );
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { release } of candidates.slice(0, KEEP_NEWEST_LAB_RELEASES)) kept.add(release);
    for (const { release } of candidates)
      if (!kept.has(release))
        await removeReleaseTree(release).catch((error: unknown) =>
          logger.warn({ err: error, release }, "Old lab release could not be removed"),
        );
  }

  const ports: LabUpdatePorts = {
    now: () => new Date(),
    blocker,
    conflict: input.conflict,
    inspectSource,
    build,
    hostRelease: () => realpath(hostLink!),
    coordinatorRelease: async () => readCurrentLink(coordinatorLink!),
    runningRelease: async () => releaseOfEntrypoint(entrypoint),
    pointHostLink: async (release) => pointLink(hostLink!, release),
    requestHostRestart(update, reason) {
      const job = restarts.request(
        { target: "host", reason, requester: "Lab self-update" },
        "owner",
      );
      if (job.status !== "pending") return job.id;
      // Approved by the Lab installation type, recorded on the lab update. Finish current
      // turns first where the coordinator supports it.
      try {
        restarts.decide(job.id, job.revision, "finish-current-turns");
      } catch (error) {
        if (!(error instanceof RestartRequestError)) throw error;
        restarts.decide(job.id, job.revision, "approve");
      }
      logger.info(
        { updateId: update.id, restartId: job.id },
        "Lab self-update Host restart approved",
      );
      return job.id;
    },
    hostRestart,
    async restartHostService() {
      if (typeof services === "string") throw new Error(services);
      // The installer engine restarts the Host the same way: the supervisor starts over and
      // resolves host-current, so the worker it launches runs the selected release.
      await createServiceControl(services).restart("host");
      logger.info("Lab self-update restarted the Host service");
    },
    cancelHostRestart(jobId) {
      const job = restarts.list().find((item) => item.id === jobId);
      if (!job) return false;
      if (job.status === "rejected") return true;
      try {
        if (job.status === "pending") restarts.decide(job.id, job.revision, "reject");
        else if (job.status === "approved") restarts.decide(job.id, job.revision, "cancel");
        else return false;
        return true;
      } catch {
        return false;
      }
    },
    launchCoordinatorSwap(update, next, previous) {
      if (!coordinatorLink || typeof services === "string")
        throw new Error("Coordinator replacement is unavailable");
      const work = path.join(directory, update.id);
      const plan: CoordinatorSwapPlan = {
        kind: "coordinator-swap",
        id: update.id,
        releaseLink: coordinatorLink,
        previous,
        next,
        services,
        health,
        outcomeFile: path.join(work, "coordinator-handoff.json"),
        timeoutMs: COORDINATOR_READY_TIMEOUT_MS,
      };
      launchHandoff({
        node: process.execPath,
        // The running coordinator's helper, beside the entrypoint in every installed release.
        helper: path.join(releaseOfEntrypoint(entrypoint), HANDOFF_HELPER),
        planFile: path.join(work, "coordinator-handoff-plan.json"),
        logFile: path.join(work, "coordinator-handoff.log"),
        plan,
      });
      logger.info({ updateId: update.id }, "Lab self-update coordinator handoff started");
    },
    coordinatorOutcome: (updateId) =>
      readHandoffOutcome(path.join(directory, updateId, "coordinator-handoff.json")),
    // Two readiness windows (new release, then rollback) plus restart slack.
    coordinatorDeadlineMs: COORDINATOR_READY_TIMEOUT_MS * 2 + 60_000,
    prune,
  };

  const updates = new LabSelfUpdates(createLabUpdateJournal(directory), ports);
  return {
    updates,
    blocker,
    async status() {
      const reason = await blocker();
      return {
        available: reason === null,
        reason,
        type: (await reportedInstallationType(config.stateDir)).type,
        updates: await updates.list(),
      };
    },
  };
}
