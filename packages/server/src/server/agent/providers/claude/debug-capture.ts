import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolvePaseoHome } from "../../../paseo-home.js";
import { CLAUDE_DEBUG_LOGS_SETTINGS_FILE } from "./account-starts.js";

/**
 * Opt-in, per-account capture of Claude Code's sign-in debug output, for diagnosing refresh
 * failures without exposing credentials.
 *
 * The CLI never receives a file path. It runs with `--debug-to-stderr`, and Vorteo, which
 * already owns the CLI's stderr through its custom spawn, diverts the debug lines here:
 *
 * - Debug lines never reach the daemon log or the in-memory stderr diagnostic.
 * - Only lines that mention sign-in topics are kept. Lines naming bearer or authorization
 *   material are dropped whole, and every token-shaped run and email address is replaced,
 *   so the file holds no credential even if the CLI's own masking misses one.
 * - Vorteo creates the private directory, checks it, and opens the file itself with
 *   O_CREAT | O_EXCL | O_NOFOLLOW at mode 0600, then writes through that descriptor.
 *
 * Off unless `$PASEO_HOME/claude-debug-logs.json` lists the account's configuration directory
 * name: `{"enabled": true, "accounts": ["claude-account-…"]}`. `{"enabled": true}` alone stays
 * off. Read at every CLI start, so toggling needs no restart.
 */

/** Extra CLI argument that sends Claude Code's debug output to stderr. */
export const CLAUDE_DEBUG_STDERR_ARGS: Record<string, null> = { "debug-to-stderr": null };

/** Stop writing once a capture file reaches this size. */
export const CLAUDE_DEBUG_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 600;
const MAX_PENDING_CHARS = 64 * 1024;

// Claude Code writes `${new Date().toISOString()} [LEVEL] message` per debug line.
const DEBUG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \[[A-Z]+\] /;
const SIGN_IN_TOPIC =
  /oauth|refresh|token|\b401\b|\b403\b|revoked|keychain|credential|\block|login|logout|sign.?in|auth|expir|invalid_grant/i;
const DROP_WHOLE_LINE = /bearer|authorization|sk-ant|cookie|set-cookie|x-api-key|api[_-]?key/i;
// Long unbroken runs of token alphabet characters: access and refresh tokens, codes, JWT parts.
const TOKEN_SHAPED = /[A-Za-z0-9_\-+/=.~%]{24,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Returns the redacted line to keep, or null to drop it. Exported for tests. */
export function redactClaudeDebugLine(line: string): string | null {
  if (!SIGN_IN_TOPIC.test(line)) return null;
  if (DROP_WHOLE_LINE.test(line)) return null;
  const redacted = line.replace(EMAIL, "[email]").replace(TOKEN_SHAPED, "[redacted]");
  return redacted.length > MAX_LINE_CHARS ? `${redacted.slice(0, MAX_LINE_CHARS)}…` : redacted;
}

export interface ClaudeDebugCapture {
  /** Absolute path of the capture file, for operator logs. */
  readonly filePath: string;
  /**
   * Takes one stderr chunk and returns the text that is not Claude debug output, to be handled
   * as ordinary stderr. Debug lines are filtered into the capture file.
   */
  accept(chunk: string): string;
  /** Flushes any partial line and closes the file. Returns leftover ordinary stderr. */
  close(): string;
  /** Settles once queued writes are on disk and the file is closed, after close(). */
  closed: Promise<void>;
}

interface DebugSettings {
  enabled?: unknown;
  accounts?: unknown;
}

function accountName(configDir: string): string {
  return path.basename(configDir);
}

async function captureRequested(home: string, account: string): Promise<boolean> {
  let parsed: DebugSettings;
  try {
    parsed = JSON.parse(
      await readFile(path.join(home, CLAUDE_DEBUG_LOGS_SETTINGS_FILE), "utf8"),
    ) as DebugSettings;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || parsed.enabled !== true) return false;
  return Array.isArray(parsed.accounts) && parsed.accounts.includes(account);
}

/** Creates or checks one private directory level. Refuses symlinks, other owners, open modes. */
async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Claude debug capture directory is not a plain directory");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error("Claude debug capture directory has another owner");
  if ((info.mode & 0o077) !== 0)
    throw new Error("Claude debug capture directory is readable by others");
}

async function openCaptureFile(
  home: string,
  account: string,
  now: Date,
): Promise<{ handle: FileHandle; file: string }> {
  const safeAccount = account.replace(/[^A-Za-z0-9._-]/g, "_") || "account";
  const logs = path.join(home, "logs");
  // The logs directory may already exist with ordinary permissions; only refuse a symlink.
  const logsInfo = await lstat(logs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!logsInfo) await mkdir(logs, { mode: 0o700 });
  else if (logsInfo.isSymbolicLink() || !logsInfo.isDirectory())
    throw new Error("Vorteo logs directory is not a plain directory");
  const root = path.join(logs, "claude-debug");
  await ensurePrivateDir(root);
  const dir = path.join(root, safeAccount);
  await ensurePrivateDir(dir);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = path.join(
    dir,
    `${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`,
  );
  const handle = await open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const info = await handle.stat();
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    await handle.close();
    throw new Error("Claude debug capture file is not private");
  }
  return { handle, file };
}

/**
 * Opens a capture for one CLI start when the account is opted in, or returns null. Any
 * filesystem refusal returns null, so the CLI starts without debug output.
 */
export async function openClaudeDebugCapture(input: {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  onError?: (error: unknown) => void;
}): Promise<ClaudeDebugCapture | null> {
  const home = resolvePaseoHome(input.env);
  const account = accountName(input.configDir);
  if (!(await captureRequested(home, account))) return null;
  let opened: { handle: FileHandle; file: string };
  try {
    opened = await openCaptureFile(home, account, input.now ?? new Date());
  } catch (error) {
    input.onError?.(error);
    return null;
  }
  return createCapture(opened.handle, opened.file);
}

function createCapture(handle: FileHandle, filePath: string): ClaudeDebugCapture {
  let pending = "";
  let queued = 0;
  let failed = false;
  let closed = false;
  // Writes run in order on the descriptor Vorteo opened; a failed write ends the capture.
  let chain: Promise<void> = Promise.resolve();

  const write = (line: string) => {
    if (closed || failed || queued >= CLAUDE_DEBUG_CAPTURE_MAX_BYTES) return;
    const kept = redactClaudeDebugLine(line);
    if (kept === null) return;
    const buffer = Buffer.from(`${kept}\n`, "utf8");
    queued += buffer.length;
    chain = chain.then(async () => {
      if (failed) return undefined;
      try {
        await handle.write(buffer);
      } catch {
        failed = true;
      }
      return undefined;
    });
  };

  // Returns ordinary stderr for one complete line, or "" for a debug line.
  const route = (line: string): string => {
    if (DEBUG_LINE.test(line)) {
      write(line);
      return "";
    }
    return `${line}\n`;
  };

  return {
    filePath,
    closed: Promise.resolve(),
    accept(chunk) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      let passthrough = "";
      for (const line of lines) passthrough += route(line);
      // An unterminated run this long is not a debug line in progress; release it as stderr,
      // unless it already looks like one, in which case it is filtered and dropped.
      if (pending.length > MAX_PENDING_CHARS) {
        if (!DEBUG_LINE.test(pending)) passthrough += pending;
        else write(pending);
        pending = "";
      }
      return passthrough;
    },
    close() {
      if (closed) return "";
      const rest = pending ? route(pending).replace(/\n$/, "") : "";
      pending = "";
      closed = true;
      this.closed = chain.then(() => handle.close()).catch(() => undefined);
      return rest;
    },
  };
}
