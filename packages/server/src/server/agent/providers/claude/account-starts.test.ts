import { expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import {
  acquireClaudeStartSlot,
  claudeRenewalInProgress,
  CLAUDE_RENEWAL_LOCK_FILE,
  waitForClaudeRenewal,
  claudeDebugLogFile,
  CLAUDE_DEBUG_LOGS_SETTINGS_FILE,
  CLAUDE_START_SLOT_MAX_MS,
} from "./account-starts.js";

// Query starts sharing one configuration-directory key queue in this process; this does not
// establish refresh completion or cross-process exclusion.
test("a Claude start waits for the same account's previous start to settle, not another account's", async () => {
  const first = await acquireClaudeStartSlot("/accounts/one");
  let settleFirst: () => void = () => {};
  first.releaseWhen(
    new Promise<void>((resolve) => {
      settleFirst = resolve;
    }),
  );

  let secondAcquired = false;
  const second = acquireClaudeStartSlot("/accounts/one").then((slot) => {
    secondAcquired = true;
    return slot;
  });
  const other = await acquireClaudeStartSlot("/accounts/two");
  other.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondAcquired).toBe(false);

  settleFirst();
  (await second).release();
  expect(secondAcquired).toBe(true);
});

test("an unresolved initialization releases its process-local start slot at the limit", async () => {
  vi.useFakeTimers();
  try {
    const account = "/fixture/unresolved-query-start";
    const first = await acquireClaudeStartSlot(account);
    first.releaseWhen(new Promise(() => {}));
    let acquired = false;
    const next = acquireClaudeStartSlot(account).then((slot) => {
      acquired = true;
      return slot;
    });
    await vi.advanceTimersByTimeAsync(CLAUDE_START_SLOT_MAX_MS - 1);
    expect(acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    (await next).release();
    expect(acquired).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["private", "public", "symlink"] as const)(
  "debug output stays unavailable for an opted-in %s filesystem path",
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-debug-custody-"));
    try {
      const home = path.join(root, "home");
      await mkdir(home, { mode: 0o700 });
      // Synthetic opt-in only. No SDK, provider, payload or actual logging runs.
      await writeFile(path.join(home, CLAUDE_DEBUG_LOGS_SETTINGS_FILE), '{"enabled":true}', {
        mode: 0o600,
      });
      const logs = path.join(home, "logs");
      if (kind === "symlink") {
        const target = path.join(root, "log-target");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, logs);
      } else {
        await mkdir(logs, { mode: kind === "private" ? 0o700 : 0o755 });
        expect((await stat(logs)).mode & 0o077).toBe(kind === "private" ? 0 : 0o055);
      }
      const result = await claudeDebugLogFile({
        configDir: path.join(root, "account"),
        env: { PASEO_HOME: home, HOME: root },
      });
      expect(result).toBeNull();
      await expect(stat(path.join(logs, "claude-debug"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Stopping a Claude Code process that holds the renewal lock loses the account's sign-in.
test("a stop waits for the account's sign-in renewal lock, but not for an abandoned one", async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), "claude-renewal-"));
  const lock = path.join(configDir, CLAUDE_RENEWAL_LOCK_FILE);
  const env = { CLAUDE_CONFIG_DIR: configDir, VORTEO_CLAUDE_SIGN_IN: "full" };
  try {
    expect(await waitForClaudeRenewal(env, { maxMs: 0 })).toBe(true);

    await mkdir(lock);
    expect(await claudeRenewalInProgress(configDir)).toBe(true);
    expect(await waitForClaudeRenewal(env, { maxMs: 30, pollMs: 5 })).toBe(false);
    // An account that cannot renew through Claude Code never waits.
    expect(await waitForClaudeRenewal({ CLAUDE_CONFIG_DIR: configDir }, { maxMs: 30 })).toBe(true);
    const stop = waitForClaudeRenewal(env, { maxMs: 5_000, pollMs: 5 });
    await rm(lock, { recursive: true });
    expect(await stop).toBe(true);

    // Closing a session of the account holds off while the lock is live.
    await mkdir(lock);
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveVersion: async () => "2.1.321",
      runtimeSettings: { env },
    });
    const session = await client.createSession({ provider: "claude", cwd: configDir });
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(closed).toBe(false);
    await rm(lock, { recursive: true });
    await closing;

    // A lock left by a dead process must not hold every later stop.
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await claudeRenewalInProgress(configDir)).toBe(false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
