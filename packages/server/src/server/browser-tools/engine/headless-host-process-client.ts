import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  encodeHeadlessHostProcessOptions,
  parseHeadlessHostChildMessage,
  type HeadlessHostParentMessage,
  type HeadlessHostProcessOptions,
} from "./headless-host-process-protocol.js";

type ExecutePayload = BrowserAutomationExecuteResponse["payload"];

// Return diagnostics before the broker's 15-second request deadline.
const READY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 10_000;

export interface HeadlessHostProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface HeadlessHostProcess {
  execute(request: BrowserAutomationExecuteRequest): Promise<ExecutePayload>;
  close(): Promise<void>;
  readonly exited: Promise<HeadlessHostProcessExit>;
}

export interface SpawnHeadlessHostProcessInput {
  options: HeadlessHostProcessOptions;
  launch?: () => ChildProcess;
  readyTimeoutMs?: number;
  onStderr?: (text: string) => void;
  onInvalidMessage?: () => void;
}

// Variables the browser host needs. Everything else in the parent's
// environment, such as SSH agent sockets and provider tokens, stays behind.
const CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;

export function headlessHostChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

// The child entry beside this module. Development runs from TypeScript
// sources, so match this module's own extension. The path is computed at run
// time on purpose: the Host startup module contract must not trace into the
// browser host entry or Playwright.
export function headlessHostProcessEntry(): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./headless-host-process${extension}`, import.meta.url));
}

export class HeadlessHostProcessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HeadlessHostProcessError";
  }
}

export function spawnHeadlessHostProcess(
  input: SpawnHeadlessHostProcessInput,
): Promise<HeadlessHostProcess> {
  const entry = headlessHostProcessEntry();
  const child =
    input.launch?.() ??
    fork(entry, [encodeHeadlessHostProcessOptions(input.options)], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
      // Daemon flags such as inspector ports must not leak into the browser
      // host. TypeScript development still needs the parent's loader.
      execArgv: entry.endsWith(".ts") ? process.execArgv : [],
      // Playwright forwards Chromium stderr and exit status through this logger,
      // including while launch is still waiting for readiness.
      env: { ...headlessHostChildEnvironment(), DEBUG: "pw:browser" },
    });
  // An unhandled error event would crash the parent, so always observe it.
  child.on("error", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  child.stderr?.setEncoding("utf8");
  let stderrTail = "";
  child.stderr?.on("data", (text: string) => {
    stderrTail = (stderrTail + text).slice(-4_000);
    input.onStderr?.(text);
  });
  function failure(message: string): HeadlessHostProcessError {
    const tail = stderrTail.trim().split("\n").slice(-20).join("\n");
    return new HeadlessHostProcessError(
      tail ? `${message}\nBrowser stderr (last lines):\n${tail}` : message,
    );
  }

  const pending = new Map<string, (payload: ExecutePayload) => void>();
  const pendingFailures = new Map<string, (error: Error) => void>();
  let exitState: HeadlessHostProcessExit | null = null;
  const exited = new Promise<HeadlessHostProcessExit>((resolve) => {
    // Wait for stderr to drain so the final crash lines reach the caller.
    child.once("close", (code, signal) => {
      exitState = { code, signal };
      for (const reject of pendingFailures.values()) {
        reject(
          failure(`The headless browser host process exited (code: ${code}, signal: ${signal}).`),
        );
      }
      pending.clear();
      pendingFailures.clear();
      resolve(exitState);
    });
  });

  const handle: HeadlessHostProcess = {
    exited,
    execute(request) {
      if (exitState || !child.connected) {
        return Promise.reject(
          new HeadlessHostProcessError("The headless browser host is not running."),
        );
      }
      return new Promise<ExecutePayload>((resolve, reject) => {
        pending.set(request.requestId, resolve);
        pendingFailures.set(request.requestId, reject);
        const message: HeadlessHostParentMessage = { type: "execute", request };
        const fail = () => {
          pending.delete(request.requestId);
          pendingFailures.delete(request.requestId);
          reject(new HeadlessHostProcessError("The headless browser host is not reachable."));
        };
        try {
          child.send(message, (error) => {
            if (error) fail();
          });
        } catch {
          fail();
        }
      });
    },
    async close() {
      if (exitState) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    },
  };

  return new Promise<HeadlessHostProcess>((resolve, reject) => {
    const timer = setTimeout(() => {
      void handle.close();
      reject(
        failure(
          `The headless browser host did not become ready within ${input.readyTimeoutMs ?? READY_TIMEOUT_MS}ms.`,
        ),
      );
    }, input.readyTimeoutMs ?? READY_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(failure(`The headless browser host failed to launch: ${error.message}`));
    });
    // After ready, this rejection is a no-op; the exit reaches callers through `exited`.
    void (async () => {
      const exit = await exited;
      clearTimeout(timer);
      reject(
        failure(
          `The headless browser host exited during startup (code: ${exit.code}, signal: ${exit.signal}).`,
        ),
      );
    })();
    child.on("message", (raw) => {
      const message = parseHeadlessHostChildMessage(raw);
      if (!message) {
        input.onInvalidMessage?.();
        return;
      }
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve(handle);
      } else if (message.type === "fatal") {
        clearTimeout(timer);
        reject(failure(message.message));
        void handle.close();
      } else if (message.type === "response") {
        const requestId = message.payload.requestId;
        const settle = pending.get(requestId);
        pending.delete(requestId);
        pendingFailures.delete(requestId);
        settle?.(message.payload);
      }
    });
  });
}
