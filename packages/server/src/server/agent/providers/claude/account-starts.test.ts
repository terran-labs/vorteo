import { expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireClaudeStartSlot,
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
