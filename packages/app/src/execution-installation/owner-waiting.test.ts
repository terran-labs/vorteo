import { expect, it } from "vitest";
import {
  instructionOwnerState,
  jobOwnerState,
  restartOwnerState,
  restartProgressLine,
} from "./owner-waiting";

// #656: what waits on the owner renders open; the rest folds away. Two guards: a state nobody
// classified waits, and a failure that still counts on System Health always waits.
type Restart = Parameters<typeof restartOwnerState>[0];
// Fields are loose on purpose: a status this interface has never seen must still classify.
const restart = (fields: Record<string, unknown>) => fields as unknown as Restart;
const policy = { policyActivatedAt: "2026-11-25T00:00:00Z", requestRevision: "r" };

it.each([
  ["a pending restart with no recorded policy", restart({ status: "pending" }), false, "waiting"],
  [
    "a pending restart approved by recorded policy",
    restart({ status: "pending", automaticApproval: policy }),
    false,
    "in-progress",
  ],
  [
    "a pending restart the policy will dispatch",
    restart({ status: "pending", automaticDispatchAfter: "2026-11-25T00:01:00Z" }),
    false,
    "in-progress",
  ],
  [
    "a restart another agent handles",
    restart({ status: "pending", delegatedTo: "Builds" }),
    false,
    "in-progress",
  ],
  [
    "a delegated restart past its grace window",
    restart({ status: "pending", delegatedTo: "Builds", delegationOverdue: "late" }),
    false,
    "waiting",
  ],
  ["a running restart", restart({ status: "running" }), false, "in-progress"],
  [
    "an approved restart past its hold deadline",
    restart({ status: "approved", holdDeadlineExceeded: true }),
    false,
    "waiting",
  ],
  ["a failed restart that still counts", restart({ status: "failed" }), true, "waiting"],
  ["a failed restart that no longer counts", restart({ status: "failed" }), false, "history"],
  ["a succeeded restart", restart({ status: "succeeded" }), false, "history"],
  ["a restart in a status nobody classified", restart({ status: "paused" }), false, "waiting"],
])("restarts: %s", (_name, job, counted, state) => {
  expect(restartOwnerState(job, counted)).toBe(state);
});

it.each([
  ["pending", undefined, false, "waiting"],
  ["running", undefined, false, "in-progress"],
  ["failed", undefined, true, "waiting"],
  ["failed", undefined, false, "history"],
  ["failed", "recovery_required", false, "waiting"],
  ["succeeded", undefined, false, "history"],
  ["cancelled", undefined, false, "history"],
  ["quarantined", undefined, false, "waiting"],
])("maintenance records: %s at %s, counted %s", (status, stage, counted, state) => {
  expect(jobOwnerState({ status, stage }, counted)).toBe(state);
});

it.each([
  ["pending", false, "waiting"],
  ["pending", true, "history"],
  ["applied", false, "history"],
  ["held", false, "waiting"],
])("instruction changes: %s, stale %s", (status, stale, state) => {
  expect(instructionOwnerState({ status }, stale)).toBe(state);
});

it("says a request is approved automatically only from its recorded policy", () => {
  expect(restartProgressLine(restart({ status: "pending" }))).toBeNull();
  expect(
    restartProgressLine(restart({ status: "pending", automaticApproval: policy })),
  ).not.toBeNull();
});
