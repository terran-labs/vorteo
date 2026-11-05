import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import type { LiveDevServerState } from "@getpaseo/protocol/live-dev";
import type { Logger } from "pino";

/**
 * Supervises the one Expo web dev server that live dev mode proxies. It binds loopback only;
 * the repository's Expo patch refuses any Host or Origin other than the installation's own.
 * The child leads its own process group so Metro's workers and the type watchers stop with it.
 */

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const READY_POLL_MS = 1_000;
const READY_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 5_000;
const MAX_FAST_FAILURES = 5;
const FAST_FAILURE_MS = 60_000;

export interface LiveDevPaths {
  /** Holds the checkout, its lock and restart requests. */
  root: string;
  checkout: string;
  restartRequest: string;
  /** Coordinator-private pidfile and log. */
  pidFile: string;
  logFile: string;
}

/** The live checkout sits beside Host releases, outside every guest-writable mount. */
export function liveDevPaths(hostReleaseLink: string, stateDir: string): LiveDevPaths {
  const root = path.join(path.dirname(path.dirname(hostReleaseLink)), "live");
  return {
    root,
    checkout: path.join(root, "source"),
    restartRequest: path.join(root, "restart-request"),
    pidFile: path.join(stateDir, "live-dev", "metro.pid"),
    logFile: path.join(stateDir, "live-dev", "metro.log"),
  };
}

export interface LiveDevServerStatus {
  state: LiveDevServerState;
  detail: string | null;
  port: number | null;
}

export interface LiveDevSupervisorOptions {
  paths: LiveDevPaths;
  origin: string;
  logger: Logger;
  /** Node used to run the launcher; the coordinator's own by default. */
  node?: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port === null) reject(new Error("No free port"));
        else resolve(port);
      });
    });
  });
}

function packagerRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/status",
        timeout: 2_000,
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => finish(body.includes("packager-status:running")));
      },
    );
    req.on("error", () => finish(false));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LAUNCHER_MARK = "live-dev-server.mjs";

/** A pid from an old pidfile may have been reused; only signal our own launcher. */
function isLiveDevLauncher(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) =>
      resolve(!error && stdout.includes(LAUNCHER_MARK)),
    );
  });
}

/** Stops a process group and verifies the leader exited. */
async function stopPid(pid: number): Promise<boolean> {
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(200);
  }
  signalGroup(pid, "SIGKILL");
  await sleep(200);
  return !alive(pid);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export class LiveDevSupervisor {
  private child: ChildProcess | null = null;
  private status: LiveDevServerStatus = {
    state: "stopped",
    detail: null,
    port: null,
  };
  private wanted = false;
  private failures: number[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private lastRestartRequest: number | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly options: LiveDevSupervisorOptions) {}

  current(): LiveDevServerStatus {
    return { ...this.status };
  }

  /**
   * Brings the dev server to the wanted state. The wish is recorded at once, so a retry or
   * restart already queued behind a stop sees it and does not start the server again.
   */
  reconcile(wanted: boolean): Promise<void> {
    this.wanted = wanted;
    if (!wanted && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return this.enqueue(() => this.apply(wanted));
  }

  /** Restarts the server when the live checkout asks, for example after a dependency change. */
  async checkRestartRequest(): Promise<void> {
    let mtime = 0;
    try {
      mtime = (await stat(this.options.paths.restartRequest)).mtimeMs;
    } catch {
      // No request yet.
    }
    const previous = this.lastRestartRequest;
    this.lastRestartRequest = mtime;
    // The first observation is a baseline: that request was served when this server started.
    if (previous === null || mtime <= previous || !this.wanted) return;
    this.options.logger.info("Live dev server restart requested by the live checkout");
    this.failures = [];
    await this.enqueue(async () => {
      await this.stopChild();
      await this.startChild();
    });
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(step).catch((error: unknown) => {
      this.status = {
        state: "failed",
        detail:
          "The live dev server could not be started or stopped. The coordinator log has details.",
        port: null,
      };
      this.options.logger.error({ err: error }, "Live dev server transition failed");
    });
    return this.transition;
  }

  private async apply(wanted: boolean): Promise<void> {
    if (!wanted || !this.wanted) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.failures = [];
      await this.stopChild();
      await this.stopStale();
      this.status = { state: "stopped", detail: null, port: null };
      return;
    }
    if (this.child) return;
    await this.stopStale();
    await this.startChild();
  }

  /** A server left by an earlier coordinator still holds its port and file watchers. */
  private async stopStale(): Promise<void> {
    const { pidFile } = this.options.paths;
    let text: string;
    try {
      text = await readFile(pidFile, "utf8");
    } catch {
      return;
    }
    const pid = Number(text.trim());
    if (
      Number.isInteger(pid) &&
      pid > 1 &&
      pid !== this.child?.pid &&
      alive(pid) &&
      (await isLiveDevLauncher(pid))
    ) {
      const stopped = await stopPid(pid);
      this.options.logger.info({ pid, stopped }, "Stopped a stale live dev server");
      if (!stopped) throw new Error(`Live dev server ${pid} did not stop`);
    }
    if (!this.child) await rm(pidFile, { force: true });
  }

  private async startChild(): Promise<void> {
    if (!this.wanted) return;
    const { paths, origin, logger } = this.options;
    const launcher = path.join(paths.checkout, "scripts", "live-dev-server.mjs");
    if (!(await fileExists(launcher))) {
      this.status = {
        state: "failed",
        detail: "The live checkout has no live dev launcher. Sync it with main.",
        port: null,
      };
      return;
    }
    await mkdir(path.dirname(paths.logFile), { recursive: true, mode: 0o700 });
    try {
      if ((await stat(paths.logFile)).size > MAX_LOG_BYTES) await truncate(paths.logFile, 0);
    } catch {
      // No log yet.
    }
    const port = await freePort();
    const log = await open(paths.logFile, "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(this.options.node ?? process.execPath, [launcher], {
        cwd: paths.checkout,
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          PASEO_LIVE_DEV_ORIGIN: origin,
          PASEO_LIVE_DEV_PORT: String(port),
        },
      });
    } finally {
      await log.close();
    }
    if (!child.pid) {
      this.status = {
        state: "failed",
        detail: "The live dev server did not start.",
        port: null,
      };
      return;
    }
    await writeFile(paths.pidFile, `${child.pid}\n`, { mode: 0o600 });
    this.child = child;
    this.status = { state: "starting", detail: null, port };
    logger.info({ pid: child.pid, port }, "Live dev server starting");
    const startedAt = Date.now();
    child.once("exit", (code, signal) => this.onExit(child, startedAt, code, signal));
    void this.awaitReady(child, port);
  }

  private async awaitReady(child: ChildProcess, port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (this.child === child && Date.now() < deadline) {
      if (await packagerRunning(port)) {
        if (this.child === child) this.status = { state: "ready", detail: null, port };
        return;
      }
      await sleep(READY_POLL_MS);
    }
    if (this.child === child)
      this.status = {
        state: "failed",
        detail:
          "The live dev server did not become ready. Its log is in the coordinator's live dev folder.",
        port,
      };
  }

  private onExit(
    child: ChildProcess,
    startedAt: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    this.child = null;
    // The type watchers share the launcher's group and would otherwise outlive it.
    if (child.pid) signalGroup(child.pid, "SIGTERM");
    void rm(this.options.paths.pidFile, { force: true });
    if (!this.wanted) return;
    const now = Date.now();
    if (now - startedAt < FAST_FAILURE_MS) this.failures.push(now);
    this.failures = this.failures.filter(
      (time) => now - time < FAST_FAILURE_MS * MAX_FAST_FAILURES,
    );
    this.options.logger.warn({ code, signal }, "Live dev server exited");
    if (this.failures.length >= MAX_FAST_FAILURES) {
      this.status = {
        state: "failed",
        detail: "The live dev server keeps exiting. Fix the live checkout, then request a restart.",
        port: null,
      };
      return;
    }
    const delay = Math.min(60_000, 2_000 * 2 ** this.failures.length);
    this.status = {
      state: "starting",
      detail: "Restarting after an exit.",
      port: null,
    };
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // A retry never revives a server the owner has since turned off.
      if (this.wanted) void this.reconcile(true);
    }, delay);
    this.retryTimer.unref();
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.child = null;
    const stopped = await stopPid(child.pid);
    await rm(this.options.paths.pidFile, { force: true });
    if (!stopped) throw new Error(`Live dev server ${child.pid} did not stop`);
    this.options.logger.info({ pid: child.pid }, "Live dev server stopped");
  }
}
