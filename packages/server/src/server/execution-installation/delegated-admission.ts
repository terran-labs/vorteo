import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DelegatedMaintenanceApprovalSchema,
  type DelegatedMaintenanceApproval,
} from "@getpaseo/protocol/maintenance-approval";
import { writePrivateFileAtomicSync } from "../private-files.js";

/**
 * Operations an active full maintenance grant never approves. This is the one place to add an
 * exclusion. Every other operation, including any added later, is delegable by default: each
 * executor asks `delegableUnderGrant` at admission and again before dispatch, so an entry here
 * takes effect for undispatched work too.
 *
 * Operation names are `<executor>:<operation>`:
 * - `restart-plan:<field>`: a plan-bound restart operation, by its wire plan field.
 * - `coordinator-plan-setting:<setting>`: a coordinator plan that changes that reviewed setting.
 * - `native:<operation>`: a native helper, preview monitor or session host operation.
 * - `coordinator-follow`: moving the coordinator onto the Host release.
 * - `coordinator-settings:<key>`: a coordinator settings change to that registered key.
 * - `broker-deployment:<operation>` and `broker-rebind:<operation>`: preview broker changes.
 * - `instruction-requests`: a change to the installation-wide agent instructions.
 * - `agent-guardrails`: any other edit to agent instructions, skills or plugins.
 * - `snapshot-restore`: restoring a pre-install safety snapshot.
 * - `source-upgrade-rollback`: rolling back a Stable source upgrade.
 * - `account-credentials`: connecting, editing or synchronizing provider accounts.
 */
export const OWNER_ONLY_OPERATIONS: readonly string[] = [
  // Owner decision 2026-11-07: agents never edit their own guardrails. An approved request
  // rewrites every agent's instructions, including the requester's.
  "instruction-requests",
  "agent-guardrails",
  // Builds charter: restoring or rolling back an install is the owner's decision. Either one
  // rolls the whole installation back, including work agents did since.
  "snapshot-restore",
  "source-upgrade-rollback",
  // Every Factory charter forbids agents to touch credentials or account settings, and the
  // maintenance grant never alters credentials.
  "account-credentials",
];

/** Whether the full maintenance grant may approve the operation. Default in. */
export function delegableUnderGrant(
  operation: string,
  excluded: readonly string[] = OWNER_ONLY_OPERATIONS,
): boolean {
  return !excluded.includes(operation);
}

/**
 * The active full grant, read fresh on every admission and dispatch. The authority digest binds
 * the grant epoch and the installation credentials, so revocation, a new grant or credential
 * rotation changes it. Null when no grant applies, including on enrolled installations.
 */
export interface DelegationGrant {
  policyActivatedAt: string;
  authoritySha256: string;
}

/** Digest of the exact work a delegated approval covers, such as a release or a patch. */
export function delegatedPlanDigest(scope: string, plan: unknown): string {
  return createHash("sha256").update(JSON.stringify({ scope, plan })).digest("hex");
}

/**
 * Evidence for one delegated approval of one exact request revision and plan. It holds only
 * until `dispatchAfter`, the cancellation window, and only while the same grant applies.
 */
export function delegatedApproval(
  grant: DelegationGrant,
  input: { requestRevision: string; planSha256: string; now: number; cancellationDelayMs: number },
): DelegatedMaintenanceApproval {
  return {
    policyActivatedAt: grant.policyActivatedAt,
    authoritySha256: grant.authoritySha256,
    requestRevision: input.requestRevision,
    planSha256: input.planSha256,
    dispatchAfter: new Date(input.now + input.cancellationDelayMs).toISOString(),
  };
}

/**
 * Whether recorded evidence still covers the request: the same grant epoch and credentials,
 * the same request revision and the same plan. Anything else invalidates it before dispatch.
 */
export function delegatedApprovalHolds(
  approval: DelegatedMaintenanceApproval,
  grant: DelegationGrant | null,
  current: { revision: string; planSha256: string },
): boolean {
  return (
    grant !== null &&
    grant.policyActivatedAt === approval.policyActivatedAt &&
    grant.authoritySha256 === approval.authoritySha256 &&
    current.revision === approval.requestRevision &&
    current.planSha256 === approval.planSha256
  );
}

/**
 * Whether an approved request may still dispatch on its delegated approval: the same grant and
 * credentials, the same plan and no new exclusion. Approval itself issues a new revision, so the
 * revision was bound at admission instead. Omit `planSha256` when the executor itself completes
 * the plan after approval, such as coordinator-computed digests; the plan was bound at admission.
 * True when the owner, not the grant, approved it.
 */
export function delegatedDispatchHolds(
  approval: DelegatedMaintenanceApproval | undefined,
  grant: DelegationGrant | null,
  current: { operations: readonly string[]; planSha256?: string },
): boolean {
  if (!approval) return true;
  return (
    current.operations.every((operation) => delegableUnderGrant(operation)) &&
    grant !== null &&
    grant.policyActivatedAt === approval.policyActivatedAt &&
    grant.authoritySha256 === approval.authoritySha256 &&
    (current.planSha256 === undefined || current.planSha256 === approval.planSha256)
  );
}

/**
 * The next delegated admission step for a pending request in a queue that holds delegated work
 * as pending until its cancellation window ends, so a rollback runtime that ignores the evidence
 * still waits for the owner. `attach` records fresh evidence; `invalid` means the grant,
 * credentials, revision, plan or exclusion list changed and the evidence must not be used;
 * `ready` means the window ended and the request may be approved and dispatched.
 */
export function delegatedAdmissionStep(
  job: {
    status: string;
    revision: string;
    createdAt: string;
    requestedBy?: string;
    delegatedApproval?: DelegatedMaintenanceApproval;
  },
  input: {
    grant: DelegationGrant | null;
    operations: readonly string[];
    planSha256: string;
    now: number;
  },
): "none" | "attach" | "invalid" | "wait" | "ready" {
  if (job.status !== "pending") return "none";
  const delegable = input.operations.every((operation) => delegableUnderGrant(operation));
  const approval = job.delegatedApproval;
  if (approval) {
    if (
      !delegable ||
      !delegatedApprovalHolds(approval, input.grant, {
        revision: job.revision,
        planSha256: input.planSha256,
      })
    )
      return "invalid";
    return input.now >= Date.parse(approval.dispatchAfter) ? "ready" : "wait";
  }
  // Only fresh Host-agent requests made under the current grant; never one made before it.
  if (
    job.requestedBy !== "host-agent" ||
    !input.grant ||
    !delegable ||
    Date.parse(job.createdAt) < Date.parse(input.grant.policyActivatedAt)
  )
    return "none";
  return "attach";
}

const DelegationEvidenceSchema = z.strictObject({
  version: z.literal(1),
  approvals: z.record(z.string().uuid(), DelegatedMaintenanceApprovalSchema),
});

/**
 * Delegated approvals kept beside a queue whose job records are strict and shared with older
 * runtimes. The records stay pending until the approval completes, so a rolled-back coordinator
 * that never reads this file sees a pending job and waits for the owner. Unreadable evidence is
 * discarded: the request falls back to owner approval or is approved afresh.
 */
export interface DelegationEvidence {
  get(id: string): DelegatedMaintenanceApproval | undefined;
  set(id: string, approval: DelegatedMaintenanceApproval): void;
  delete(id: string): void;
}

export function createDelegationEvidence(file: string): DelegationEvidence {
  const read = (): Record<string, DelegatedMaintenanceApproval> => {
    if (!existsSync(file)) return {};
    try {
      return DelegationEvidenceSchema.parse(JSON.parse(readFileSync(file, "utf8"))).approvals;
    } catch {
      return {};
    }
  };
  const write = (approvals: Record<string, DelegatedMaintenanceApproval>) => {
    if (Object.keys(approvals).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(file, JSON.stringify({ version: 1, approvals }));
  };
  return {
    get: (id) => read()[id],
    set: (id, approval) => write({ ...read(), [id]: approval }),
    delete: (id) => {
      const approvals = read();
      if (!(id in approvals)) return;
      delete approvals[id];
      write(approvals);
    },
  };
}

/** In memory, for tests and queues without a state directory. */
export function memoryDelegationEvidence(): DelegationEvidence {
  const approvals = new Map<string, DelegatedMaintenanceApproval>();
  return {
    get: (id) => approvals.get(id),
    set: (id, approval) => void approvals.set(id, approval),
    delete: (id) => void approvals.delete(id),
  };
}
