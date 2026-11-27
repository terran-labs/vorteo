import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess } from "@getpaseo/plugin/server";
import { signalProcess } from "./signals.js";
import { createInterface } from "node:readline";
import type { ProviderLaunch, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import {
  AntigravityError,
  decodeFrame,
  diagnostic,
  encodePrompt,
  type Frame,
  type Init,
} from "./wire.js";

interface DriverOptions {
  launch: ProviderLaunch;
  config: ProviderSessionConfig;
  conversationId: string | null;
  onFrame(frame: Frame): void;
  onExit(error: AntigravityError): void;
}

export interface Driver {
  ready: Promise<Init>;
  selection: string;
  prompt(text: string): Promise<void>;
  stop(reason: "interrupt" | "close"): Promise<void>;
}

export function selection(config: ProviderSessionConfig): string {
  return JSON.stringify([config.model, config.mode]);
}

function driverArgs(options: DriverOptions): string[] {
  const { config, conversationId } = options;
  const args = [
    ...options.launch.args,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--add-dir",
    config.cwd,
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
  ];
  if (config.model) args.push("--model", config.model);
  if (conversationId) args.push("--conversation", conversationId);
  return args;
}

export function startDriver(options: DriverOptions): Driver {
  const child = spawnProcess(options.launch.command, driverArgs(options), {
    cwd: options.config.cwd,
    env: { ...options.launch.env, ...options.config.env },
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
  const lines = createInterface({ input: child.stdout });
  let cleanup = Promise.resolve();
  let stderr = "";
  let state: "starting" | "ready" | "stopping" | "exited" = "starting";
  let resolveReady: (init: Init) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<Init>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const startupDeadline = setTimeout(
    () =>
      fail(
        new AntigravityError("Antigravity did not initialize within 30 seconds", "STARTUP_TIMEOUT"),
      ),
    30_000,
  );
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  child.stdin.on("error", (error: Error) =>
    fail(new AntigravityError(error.message, "STDIN_ERROR")),
  );
  child.on("error", (error: Error) => fail(new AntigravityError(error.message, "SPAWN_ERROR")));
  child.on("close", (code, signal) => {
    clearTimeout(startupDeadline);
    lines.close();
    const error = new AntigravityError(
      diagnostic(stderr.trim() || `Antigravity exited (${signal || code})`),
      "PROCESS_EXIT",
    );
    if (state === "starting") rejectReady(error);
    if (state === "ready") options.onExit(error);
    state = "exited";
    resolveExit();
  });
  lines.on("line", (line) => {
    if (!line.trim() || state === "exited" || state === "stopping") return;
    let decoded: Frame;
    try {
      decoded = decodeFrame(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(new AntigravityError(`Invalid Antigravity output: ${message}`, "INVALID_FRAME"));
      return;
    }
    if (state === "starting") {
      if (decoded.event === "init") {
        clearTimeout(startupDeadline);
        state = "ready";
        resolveReady(decoded);
      } else if (decoded.event === "result") {
        fail(new AntigravityError(diagnostic(decoded.result.error), "STARTUP_ERROR"));
      }
      return;
    }
    options.onFrame(decoded);
  });

  function fail(failure: AntigravityError): void {
    clearTimeout(startupDeadline);
    if (state === "starting") rejectReady(failure);
    if (state === "ready") options.onExit(failure);
    if (state === "exited" || state === "stopping") return;
    state = "stopping";
    cleanup = Promise.resolve(signalGroup(child, "SIGKILL"));
    // The stop operation awaits cleanup and owns reporting its failure.
    void cleanup.catch(() => undefined);
  }

  return {
    ready,
    selection: selection(options.config),
    prompt(text) {
      if (state !== "ready")
        return Promise.reject(new AntigravityError("Antigravity is not ready"));
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(encodePrompt(text), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    async stop(reason) {
      if (process.platform === "win32") await cleanup;
      if (state === "exited") return;
      if (state === "starting") rejectReady(new AntigravityError("Antigravity startup canceled"));
      clearTimeout(startupDeadline);
      state = "stopping";
      if (process.platform === "win32") {
        // Node signal emulation kills only the leader; taskkill must see the live tree.
        cleanup = Promise.resolve(signalGroup(child, "SIGKILL"));
        await cleanup;
        await exited;
        return;
      }
      if (reason === "close") child.stdin.end();
      else signalGroup(child, "SIGINT");
      const terminate = setTimeout(() => signalGroup(child, "SIGTERM"), 1000);
      const kill = setTimeout(() => signalGroup(child, "SIGKILL"), 2000);
      await exited;
      clearTimeout(terminate);
      clearTimeout(kill);
      // A tool can keep running after its CLI leader exits.
      signalGroup(child, "SIGKILL");
    },
  };
}

function signalGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void | Promise<void> {
  if (!child.pid) return;
  return signalProcess({ platform: process.platform, pid: child.pid, signal });
}

const DEFAULT_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

function cleanupGroupQuietly(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") process.kill(child.pid, "SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // Process group already exited or cannot be signaled after close.
  }
}

interface ProbeOptions {
  launch: ProviderLaunch;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cleanupProcessGroup?: boolean;
  abortOnStderr?: RegExp;
}
export function probe(options: ProbeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROBE_MAX_OUTPUT_BYTES;
    const child = spawnProcess(options.launch.command, [...options.launch.args, ...options.args], {
      env: options.launch.env,
      cwd: options.cwd,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      const trimmedStderr = stderr.trim();
      const termination = Promise.resolve(signalGroup(child, "SIGKILL"));
      void termination.then(() => {
        if (options.abortOnStderr?.test(trimmedStderr)) {
          reject(new AntigravityError(diagnostic(trimmedStderr), "PROBE_ERROR", 1, trimmedStderr));
          return undefined;
        }
        reject(new AntigravityError("Antigravity discovery timed out", "PROBE_TIMEOUT"));
        return undefined;
      }, reject);
    }, options.timeoutMs ?? 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxOutputBytes - stdout.length;
      if (remaining > 0) stdout += chunk.toString().slice(0, remaining);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      if (!settled && options.abortOnStderr?.test(stderr)) {
        settled = true;
        clearTimeout(deadline);
        cleanupGroupQuietly(child);
        const trimmedStderr = stderr.trim();
        reject(new AntigravityError(diagnostic(trimmedStderr), "PROBE_ERROR", 1, trimmedStderr));
      }
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new AntigravityError(error.message, "SPAWN_ERROR"));
    });
    child.on("close", (code) => {
      if (options.cleanupProcessGroup) cleanupGroupQuietly(child);
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (code === 0) resolve(stdout);
      else {
        const trimmedStderr = stderr.trim();
        reject(
          new AntigravityError(
            diagnostic(trimmedStderr || `agy exited with code ${code}`),
            "PROBE_ERROR",
            code,
            trimmedStderr,
          ),
        );
      }
    });
  });
}
