import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorDispatchStatus,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { coordinatorLifecycleBlockers } from "./coordinator-bootstrap.js";
import {
  type CoordinatorDispatchFailure,
  currentDispatchFailure,
  readCoordinatorDispatchFailures,
} from "./coordinator-bootstrap-dispatch-failure.js";

/** An approval with no claim and no live runner after this long is reported as stalled. */
export const DISPATCH_STALL_MS = 3 * 60_000;

const RunnerEvidenceSchema = z.object({
  requestId: z.string(),
  pid: z.number().int().positive(),
  outcome: z.string(),
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Display only: runner evidence is diagnostic and never decides admission. */
function hasLiveRunner(directory: string, requestId: string): boolean {
  let names: string[];
  try {
    names = readdirSync(directory).filter(
      (name) => name.startsWith(`coordinator-runner-${requestId}-`) && name.endsWith(".json"),
    );
  } catch {
    return false;
  }
  return names.some((name) => {
    try {
      const evidence = RunnerEvidenceSchema.parse(
        JSON.parse(readFileSync(path.join(directory, name), "utf8")),
      );
      return (
        evidence.requestId === requestId &&
        evidence.outcome === "running" &&
        processAlive(evidence.pid)
      );
    } catch {
      return false;
    }
  });
}

function awaitingClaim(request: CoordinatorBootstrapRequest): boolean {
  return request.status === "approved" && !request.execution;
}

/**
 * Failure, readiness and stall views for the owner's review. None of these change
 * admission: the claim still runs the authoritative idle check under the journal lock,
 * and a failure is already recorded as the ledger's canceled status.
 */
export function coordinatorDispatchStatuses(input: {
  requests: CoordinatorBootstrapRequest[];
  /** The installation lifecycle journal, read only when a request can still dispatch. */
  readLifecycle(): unknown;
  now: number;
}): Map<string, CoordinatorDispatchStatus> {
  const statuses = new Map<string, CoordinatorDispatchStatus>();
  const directories = new Set(input.requests.map((request) => request.plan.state.directory));
  const failures = new Map<string, CoordinatorDispatchFailure>();
  for (const directory of directories)
    for (const [id, failure] of readCoordinatorDispatchFailures(directory))
      failures.set(id, failure);
  const undecided = input.requests.filter(
    (request) => request.status === "pending" || awaitingClaim(request),
  );
  let blockers: string[] | null = null;
  if (undecided.length > 0) {
    try {
      blockers = coordinatorLifecycleBlockers(input.readLifecycle());
    } catch {
      blockers = ["The installation journal could not be read. Inspect Installation controls."];
    }
  }
  const checkedAt = new Date(input.now).toISOString();
  for (const request of input.requests) {
    const status: CoordinatorDispatchStatus = {};
    const failure = currentDispatchFailure(request, failures);
    if (failure)
      status.failure = {
        failedAt: failure.failedAt,
        category: failure.category,
        reason: failure.reason,
      };
    if (blockers && (request.status === "pending" || awaitingClaim(request)))
      status.readiness = {
        state: blockers.length > 0 ? "blocked" : "ready",
        checkedAt,
        blockers: blockers.slice(0, 8),
      };
    const stall = stalledSince(request);
    if (
      stall !== null &&
      input.now >= stall + DISPATCH_STALL_MS &&
      !hasLiveRunner(request.plan.state.directory, request.id)
    )
      status.stalled = {
        since: new Date(stall).toISOString(),
        reason:
          blockers && blockers.length > 0
            ? `Approved but not started, and no coordinator runner is active. ${blockers[0]}.`
            : "Approved but not started, and no coordinator runner is active. Inspect Installation controls; cancel and prepare a new update if it does not start.",
      };
    if (status.failure || status.readiness || status.stalled) statuses.set(request.id, status);
  }
  return statuses;
}

/** The time from which an approved request is expected to have a runner. */
function stalledSince(request: CoordinatorBootstrapRequest): number | null {
  if (!awaitingClaim(request) || !request.decisionAt) return null;
  const decided = Date.parse(request.decisionAt);
  const dispatchAfter = request.automaticApproval
    ? Date.parse(request.automaticApproval.dispatchAfter)
    : decided;
  return Math.max(decided, dispatchAfter);
}
