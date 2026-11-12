import { expect, test, vi } from "vitest";
import { acquireClaudeStartSlot, CLAUDE_START_SLOT_MAX_MS } from "./account-starts.js";

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
