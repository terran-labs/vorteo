import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolvePaseoHome } from "../../../paseo-home.js";

/**
 * Claude Code refreshes its sign-in while it starts, and the server rotates the refresh token on
 * every refresh. A CLI killed between the rotation and its Keychain save loses the account's
 * sign-in; so can several CLIs for one account racing the same refresh token. These helpers keep
 * one account's CLI starts apart and tell the session host when a CLI is too young to stop.
 */

/** Longest a start holds its account's slot before the next start may go ahead regardless. */
export const CLAUDE_START_SLOT_MAX_MS = 15_000;
/** A CLI this young may still be refreshing its sign-in, so an idle release or shutdown waits. */
export const CLAUDE_PROVIDER_SETTLE_MS = 60_000;

const startTails = new Map<string, Promise<void>>();

export interface ClaudeStartSlot {
  /** Holds the slot until the started CLI settles, bounded by the slot's maximum hold. */
  releaseWhen(settled: Promise<unknown>): void;
  /** Frees the slot now, for a start that never spawned a CLI. Safe to call more than once. */
  release(): void;
}

/**
 * Waits for the previous start for the same Claude account to settle, then holds the account's
 * slot. Different accounts never wait for each other. Every slot frees itself after maxHoldMs.
 */
export async function acquireClaudeStartSlot(
  account: string,
  maxHoldMs: number = CLAUDE_START_SLOT_MAX_MS,
): Promise<ClaudeStartSlot> {
  const previous = startTails.get(account) ?? Promise.resolve();
  let free!: () => void;
  const freed = new Promise<void>((resolve) => {
    free = resolve;
  });
  const tail = previous.then(() => freed);
  startTails.set(account, tail);
  void tail.finally(() => {
    if (startTails.get(account) === tail) startTails.delete(account);
  });
  await previous;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    free();
  };
  const timer = setTimeout(release, maxHoldMs);
  timer.unref?.();
  return {
    releaseWhen(settled) {
      void settled.catch(() => undefined).finally(release);
    },
    release,
  };
}

/** True while a CLI started at startedAt is younger than settleMs and may still be refreshing. */
export function claudeProviderSettling(
  startedAt: number | null,
  now: number = Date.now(),
  settleMs: number = CLAUDE_PROVIDER_SETTLE_MS,
): boolean {
  return startedAt !== null && now - startedAt < settleMs;
}

/**
 * Opt-in Claude Code debug logs, for diagnosing sign-in loss. Off unless
 * `$PASEO_HOME/claude-debug-logs.json` contains `{"enabled": true}`. The file sits outside
 * config.json on purpose: config.json is parsed strictly, and older releases ignore this file.
 * Read at every CLI start, so turning it on or off needs no restart.
 */
export const CLAUDE_DEBUG_LOGS_SETTINGS_FILE = "claude-debug-logs.json";

/**
 * The `--debug-file` path for one CLI start, or null while debug logs are off. Each start gets its
 * own file in a private per-account directory under the state directory, named by start time, so
 * the first CLI to reach the token endpoint can be told apart. The CLI writes only its own debug
 * output there; Vorteo adds nothing, and never a credential.
 */
export async function claudeDebugLogFile(input: {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<string | null> {
  const home = resolvePaseoHome(input.env);
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(home, CLAUDE_DEBUG_LOGS_SETTINGS_FILE), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || (parsed as { enabled?: unknown }).enabled !== true)
      return null;
  } catch {
    return null;
  }
  // The account directory's name, or a short digest when it has none worth showing.
  const base = path.basename(input.configDir).replace(/[^A-Za-z0-9._-]/g, "_");
  const account =
    base && base !== ".claude"
      ? base
      : `default-${createHash("sha256").update(input.configDir).digest("hex").slice(0, 8)}`;
  const dir = path.join(home, "logs", "claude-debug", account);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
}
