import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import type { LiveDevMode, LiveDevStatus } from "@getpaseo/protocol/live-dev";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { InstallationConfig } from "../config.js";
import { createLiveDevMiddleware, forwardLiveDevUpgrade, isLiveDevSocketPath } from "./proxy.js";
import {
  changeLiveDevMode,
  readLiveDevMode,
  UNREADABLE_REVISION,
  type LiveDevModeRecord,
} from "./state.js";
import { liveDevPaths, LiveDevSupervisor, type LiveDevPaths } from "./supervisor.js";

const run = promisify(execFile);
const RESTART_REQUEST_POLL_MS = 2_000;
/** A first dependency install and app dependency build can take several minutes. */
const PREPARE_TIMEOUT_MS = 20 * 60_000;

export class LiveDevUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveDevUnavailable";
  }
}

interface LiveDevTarget {
  paths: LiveDevPaths;
  origin: string;
  sourceDirectory: string;
}

/** Why this installation cannot run live dev mode, or its paths when it can. */
function resolveTarget(config: InstallationConfig): LiveDevTarget | string {
  const deployment = config.deployment;
  if (!deployment?.hostReleaseLink)
    return "Live dev mode needs a Host installed by the Vorteo installer.";
  const origin = new URL(config.public.origin);
  // The Expo patch admits only a private Tailscale HTTPS origin.
  if (origin.protocol !== "https:" || !origin.hostname.endsWith(".ts.net"))
    return "Live dev mode needs the installation's private .ts.net HTTPS address.";
  return {
    paths: liveDevPaths(deployment.hostReleaseLink, config.stateDir),
    origin: origin.origin,
    sourceDirectory: deployment.sourceDirectory,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(checkout: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", checkout, ...args], {
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface LiveDevServiceOptions {
  config: InstallationConfig;
  logger: Logger;
  /** Whether a Cookie header carries a valid owner session for the public origin. */
  ownerSession: (cookieHeader: string | undefined) => boolean;
  secureCookies: boolean;
}

interface Preparation {
  state: "idle" | "running" | "failed";
}

/**
 * Live dev mode for one installation: the owner's mode, the dev server, the proxy and the Fast
 * Refresh socket. The mode is cached in memory, so requests never read the disk. See
 * docs/live-dev-mode.md.
 */
export function createLiveDev(options: LiveDevServiceOptions) {
  const { config } = options;
  const logger = options.logger.child({ module: "live-dev" });
  const target = resolveTarget(config);
  const supervisor =
    typeof target === "string"
      ? null
      : new LiveDevSupervisor({
          paths: target.paths,
          origin: target.origin,
          logger,
        });
  // Unknown until the record loads, which serves static, the safe reading.
  let record: LiveDevModeRecord | null = null;
  let recordError: string | null = null;
  const preparation: Preparation = { state: "idle" };

  /** Creates the live checkout the first time live mode turns on. */
  async function prepareCheckout(live: LiveDevTarget): Promise<void> {
    const { checkout, root } = live.paths;
    // The tool records this key only after a successful install, so a failed one is retried.
    if (await exists(path.join(root, "prepared-key"))) return;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const git = (args: string[]) =>
      run("git", ["-C", live.sourceDirectory, ...args], { timeout: 120_000 });
    if (!(await exists(checkout))) {
      await git(["fetch", "--no-prune", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      const branch = await gitOutput(live.sourceDirectory, [
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/heads/live/main",
      ]);
      await git(
        branch
          ? ["worktree", "add", checkout, "live/main"]
          : ["worktree", "add", "-b", "live/main", checkout, "origin/main"],
      );
    }
    await run(process.execPath, [path.join(checkout, "scripts", "live-dev.mjs"), "prepare"], {
      cwd: checkout,
      timeout: PREPARE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // Like the dev server, preparation gets no coordinator secrets from the environment.
      env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG },
    });
  }

  async function startLive(live: LiveDevTarget, liveSupervisor: LiveDevSupervisor): Promise<void> {
    if (preparation.state === "running") return;
    preparation.state = "running";
    try {
      await prepareCheckout(live);
      preparation.state = "idle";
    } catch (error) {
      preparation.state = "failed";
      logger.error({ err: error }, "Live checkout preparation failed");
      return;
    }
    // The owner may have switched back while the checkout was prepared.
    if (record?.mode === "live") await liveSupervisor.reconcile(true);
  }

  function apply(mode: LiveDevMode): void {
    if (!supervisor || typeof target === "string") return;
    if (mode === "live") void startLive(target, supervisor);
    else void supervisor.reconcile(false);
  }

  async function load(): Promise<void> {
    try {
      record = await readLiveDevMode(config.stateDir);
      recordError = null;
    } catch (error) {
      record = null;
      recordError = "The installation type record is unreadable.";
      logger.error({ err: error }, "Installation type unreadable; serving static");
    }
    apply(record?.mode ?? "reliable");
  }

  function serverStatus(): LiveDevStatus["server"] {
    if (preparation.state === "running")
      return { state: "starting", detail: "Preparing the live checkout." };
    if (preparation.state === "failed")
      return {
        state: "failed",
        detail: "The live checkout could not be prepared. The coordinator log has details.",
      };
    const server = supervisor?.current();
    return {
      state: server?.state ?? "stopped",
      detail: server?.detail ?? null,
    };
  }

  async function status(): Promise<LiveDevStatus> {
    const reason = typeof target === "string" ? target : recordError;
    let checkout: LiveDevStatus["checkout"] = null;
    if (typeof target !== "string" && (await exists(target.paths.checkout)))
      checkout = {
        path: target.paths.checkout,
        branch: await gitOutput(target.paths.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]),
        head: await gitOutput(target.paths.checkout, ["rev-parse", "HEAD"]),
      };
    return {
      available: reason === null,
      reason,
      mode: record?.mode ?? "reliable",
      revision: record?.revision ?? UNREADABLE_REVISION,
      changedAt: record?.changedAt ?? null,
      server: serverStatus(),
      checkout,
    };
  }

  // Owner changes run one at a time, so compare-and-set cannot interleave.
  let changes: Promise<unknown> = Promise.resolve();
  function change(input: unknown): Promise<LiveDevStatus> {
    const next = changes.then(() => applyChange(input));
    changes = next.catch(() => undefined);
    return next;
  }

  async function applyChange(input: unknown): Promise<LiveDevStatus> {
    const requested = (input as { mode?: unknown } | null)?.mode;
    if (requested === "live" && typeof target === "string") throw new LiveDevUnavailable(target);
    record = await changeLiveDevMode(config.stateDir, input);
    recordError = null;
    if (record.mode === "live" && preparation.state === "failed") preparation.state = "idle";
    apply(record.mode);
    return status();
  }

  function servingPort(): number | null {
    if (!supervisor || record?.mode !== "live" || preparation.state !== "idle") return null;
    const server = supervisor.current();
    return server.state === "ready" ? server.port : null;
  }

  /**
   * `alias` serves the live interface on a second origin the coordinator answers, the custom
   * domain, while the dev server keeps admitting only the canonical one.
   */
  function middleware(installation: () => ExecutionInstallation, alias?: string): RequestHandler {
    return createLiveDevMiddleware({
      ...(alias && typeof target !== "string" ? { upstreamHost: new URL(target.origin).host } : {}),
      port: servingPort,
      ownerSession: (req) => options.ownerSession(req.headers.cookie),
      label: "Vorteo",
      installation,
      logger,
      secureCookies: options.secureCookies,
      liveMode: () => record?.mode === "live",
      serverStatus,
    });
  }

  /** Forwards `/hot` for the owner on the public origin or the custom domain. True when handled. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (typeof target === "string") return false;
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!isLiveDevSocketPath(pathname)) return false;
    const port = servingPort();
    const canonical = new URL(target.origin).host;
    const alias = config.recoveryOrigin;
    const viaAlias =
      alias !== undefined &&
      req.headers.host === new URL(alias).host &&
      req.headers.origin === alias;
    if (
      port === null ||
      (!viaAlias && (req.headers.host !== canonical || req.headers.origin !== target.origin)) ||
      !options.ownerSession(req.headers.cookie)
    ) {
      socket.destroy();
      return true;
    }
    forwardLiveDevUpgrade(
      req,
      socket,
      head,
      port,
      viaAlias ? { host: canonical, origin: target.origin } : undefined,
    );
    return true;
  }

  /**
   * The installation type, changed through its own owner route, decides the mode, so a change
   * there reaches the dev server on the next poll.
   */
  let reloading = false;
  async function followInstallationType(): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      const previous = record?.mode ?? null;
      const before = recordError;
      try {
        record = await readLiveDevMode(config.stateDir);
        recordError = null;
      } catch (error) {
        record = null;
        recordError = "The installation type record is unreadable.";
        if (before === null)
          logger.error({ err: error }, "Installation type unreadable; serving static");
      }
      const mode = record?.mode ?? "reliable";
      if (mode !== (previous ?? "reliable")) {
        if (mode === "live" && preparation.state === "failed") preparation.state = "idle";
        apply(mode);
      }
    } finally {
      reloading = false;
    }
  }

  const timer = setInterval(() => {
    // In the owner change chain, so a poll can never cache a reading older than a change.
    const poll = changes.then(followInstallationType);
    changes = poll.catch(() => undefined);
    if (record?.mode === "live") void supervisor?.checkRestartRequest();
  }, RESTART_REQUEST_POLL_MS);
  timer.unref();
  void load();

  async function stop(): Promise<void> {
    clearInterval(timer);
    await supervisor?.reconcile(false);
  }

  return { status, change, middleware, upgrade, stop };
}
