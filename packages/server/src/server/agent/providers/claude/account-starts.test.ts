import { expect, test } from "vitest";
import { acquireClaudeStartSlot } from "./account-starts.js";

// Several CLIs for one account starting at once can race its sign-in refresh and lose the grant
// (11-11 incident). Starts queue per account until the previous CLI settles; accounts never wait
// for each other.
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
