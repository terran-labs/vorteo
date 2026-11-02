import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import type { CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";
import { writePrivateFileAtomicSync } from "../private-files.js";
import {
  BootstrapAuthenticationRequired,
  BootstrapCoordinatorBusy,
  BootstrapRequestConflict,
} from "./coordinator-bootstrap-errors.js";

// COMPAT(coordinatorDispatchFailure): kept beside the strict request ledger, not in it,
// so a rollback coordinator that predates this record still parses its ledger. The
// ledger itself records only the existing canceled status.
const FILE_PREFIX = "coordinator-dispatch-failure-";

export const CoordinatorDispatchFailureSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  /** The approved revision whose dispatch failed. */
  approvedRevision: z.string().uuid(),
  /** The canceled revision this failure explains. A record whose request carries
   * another revision is stale and never shown. */
  closedRevision: z.string().uuid(),
  failedAt: z.string().datetime(),
  category: z.enum(["busy", "conflict", "authentication", "error"]),
  reason: z.string().min(1).max(600),
});
export type CoordinatorDispatchFailure = z.infer<typeof CoordinatorDispatchFailureSchema>;

/** Plain-language reason for a dispatch that stopped before its durable claim.
 * Conflict messages are fixed strings written by the coordinator; any other error
 * can carry private paths or configuration, so it is never copied. */
export function describeDispatchFailure(error: unknown): {
  category: CoordinatorDispatchFailure["category"];
  reason: string;
} {
  const prefix = "The update stopped before changing anything.";
  const next = "Prepare a new coordinator update once this is resolved.";
  if (error instanceof BootstrapCoordinatorBusy)
    return {
      category: "busy",
      reason: `${prefix} Other installation work was still unresolved: ${error.message}. Finish or cancel it in Installation controls. ${next}`,
    };
  if (error instanceof BootstrapAuthenticationRequired)
    return {
      category: "authentication",
      reason: `${prefix} ${error.message}. ${next}`,
    };
  if (error instanceof BootstrapRequestConflict)
    return {
      category: "conflict",
      reason: `${prefix} ${error.message}. ${next}`,
    };
  return {
    category: "error",
    reason: `${prefix} The coordinator could not verify dispatch. Its private runner diagnostics hold the details. ${next}`,
  };
}

function failureFile(directory: string, requestId: string): string {
  z.string().uuid().parse(requestId);
  return path.join(directory, `${FILE_PREFIX}${requestId}.json`);
}

export function writeCoordinatorDispatchFailure(
  directory: string,
  failure: CoordinatorDispatchFailure,
): void {
  const record = CoordinatorDispatchFailureSchema.parse(failure);
  writePrivateFileAtomicSync(failureFile(directory, record.requestId), JSON.stringify(record));
}

/** Diagnostic display only. A missing, unreadable or stale record hides the reason;
 * it never changes admission, which the ledger's canceled status already decides. */
export function readCoordinatorDispatchFailures(
  directory: string,
): Map<string, CoordinatorDispatchFailure> {
  const failures = new Map<string, CoordinatorDispatchFailure>();
  let names: string[];
  try {
    names = readdirSync(directory).filter(
      (name) => name.startsWith(FILE_PREFIX) && name.endsWith(".json"),
    );
  } catch {
    return failures;
  }
  for (const name of names) {
    try {
      const record = CoordinatorDispatchFailureSchema.parse(
        JSON.parse(readFileSync(path.join(directory, name), "utf8")),
      );
      if (name === `${FILE_PREFIX}${record.requestId}.json`) failures.set(record.requestId, record);
    } catch {
      // Ignore a partial or foreign file; the request still shows as canceled.
    }
  }
  return failures;
}

/** The failure belongs to this request only while the ledger still holds the exact
 * canceled revision it explains. */
export function currentDispatchFailure(
  request: { id: string; revision: string; status: string },
  failures: ReadonlyMap<string, CoordinatorDispatchFailure>,
): CoordinatorDispatchFailure | undefined {
  const failure = failures.get(request.id);
  if (!failure || request.status !== "canceled" || failure.closedRevision !== request.revision)
    return undefined;
  return failure;
}

/** A dispatch that failed before its durable claim made no lifecycle change.
 * Close the exact approval so it reports a failure instead of waiting forever, and
 * keep a plain reason beside the ledger. Never throws over the original error. */
export function closeFailedPreclaimDispatch(
  requests: Pick<CoordinatorBootstrapRequests, "closeFailedDispatch">,
  request: CoordinatorBootstrapRequest,
  error: unknown,
): void {
  const closedRevision = randomUUID();
  let closed: CoordinatorBootstrapRequest | null = null;
  try {
    closed = requests.closeFailedDispatch(
      {
        id: request.id,
        revision: request.revision,
        planSha256: request.planSha256,
      },
      closedRevision,
    );
  } catch {
    process.stderr.write("Coordinator could not close the failed approval.\n");
  }
  if (!closed) return;
  try {
    writeCoordinatorDispatchFailure(request.plan.state.directory, {
      version: 1,
      requestId: request.id,
      approvedRevision: request.revision,
      closedRevision,
      failedAt: closed.decisionAt ?? new Date().toISOString(),
      ...describeDispatchFailure(error),
    });
  } catch {
    // The ledger already shows the request as canceled; only the reason is lost.
    process.stderr.write("Coordinator dispatch failure reason could not be retained.\n");
  }
}
