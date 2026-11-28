import { z } from "zod";
import { readMachinePublicKey } from "./host-key.js";
import type { MergeEvidence } from "../merge-gate.js";
import {
  LEAN_PROTOCOL_MAJOR,
  type DispatchAction,
  type Installation,
  type Lane,
  type Lease,
  type RunnerRef,
  type Verdict,
} from "../types.js";

type OpenEvidence = Extract<MergeEvidence, { kind: "open" }>;
const installationId = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const roleConfig = z.object({
  version: z.literal(1),
  mode: z.literal("lean"),
  order: z.array(z.string()).optional(),
  lanes: z.record(z.string(), z.unknown()).optional(),
  claimers: z.array(z.string()).optional(),
  machines: z.unknown().optional(),
  runners: z.object({ placement: z.string().optional() }).optional(),
});

const machineKey = z
  .string()
  .max(4096)
  .refine((pem) => readMachinePublicKey(pem) !== null);
const machineList = z.record(
  installationId,
  z
    .strictObject({
      publicKey: machineKey,
      overlapPublicKey: machineKey.optional(),
      friendlyName: z.string().trim().min(1).optional(),
    })
    .refine(
      ({ publicKey, overlapPublicKey }) =>
        overlapPublicKey === undefined || distinctPublicKeys(publicKey, overlapPublicKey),
    ),
);

function distinctPublicKeys(active: string, overlap: string): boolean {
  const activeKey = readMachinePublicKey(active);
  const overlapKey = readMachinePublicKey(overlap);
  return activeKey !== null && overlapKey !== null && !activeKey.equals(overlapKey);
}

export interface MachineRoles {
  readonly here: Installation;
  readonly primary: Installation;
  readonly canClaim: boolean;
  readonly listsMachine: (installation: Installation) => boolean;
  readonly publicKeyFor: (installation: Installation) => string | null;
  readonly publicKeysFor: (installation: Installation) => readonly string[];
  readonly friendlyNameFor: (installation: Installation) => string | null;
}

/** Resolve using the owner configuration read from the default branch. */
export function resolveMachineRoles(
  rawConfig: unknown,
  here: Installation,
): { roles: MachineRoles; error: null } | { roles: null; error: string } {
  if (!installationId.safeParse(here).success)
    return {
      roles: null,
      error: "Use the local installation ID from vorteo factory project show.",
    };
  const parsedConfig = roleConfig.safeParse(rawConfig);
  if (!parsedConfig.success)
    return {
      roles: null,
      error: "Set version to 1 and mode to lean in .github/vorteo-factory.json.",
    };
  const config = parsedConfig.data;
  const primary = config.order?.[0];
  if (config.order?.length !== 1 || !primary || !installationId.safeParse(primary).success)
    return {
      roles: null,
      error:
        "Set order in .github/vorteo-factory.json to exactly one <serverId>/<projectId> entry for the primary.",
    };
  if (Object.keys(config.lanes ?? {}).length > 0)
    return { roles: null, error: "Remove lane overrides from the fixed-primary V1 configuration." };
  const host = config.runners?.placement === "host";
  // Host runner projects use a roster only. Ignore any old key fields without parsing them.
  const hostRoster = z.record(
    installationId,
    z.object({ friendlyName: z.string().trim().min(1).optional() }),
  );
  const parsed = (host ? hostRoster : machineList).safeParse(config.machines ?? {});
  if (!parsed.success)
    return {
      roles: null,
      error:
        "List machine keys in machines by installation ID. Use Ed25519 PEM for publicKey and any distinct overlapPublicKey.",
    };
  const machines = new Map<
    string,
    { publicKey?: string; overlapPublicKey?: string; friendlyName?: string }
  >(Object.entries(parsed.data));
  if (host && !machines.has(primary))
    return { roles: null, error: "List the fixed primary in the project's machine roster." };
  return {
    roles: {
      here,
      primary,
      listsMachine: (installation) => machines.has(installation),
      canClaim: (!host || machines.has(here)) && (config.claimers?.includes(here) ?? true),
      publicKeyFor: (installation) => machines.get(installation)?.publicKey ?? null,
      publicKeysFor(installation) {
        const machine = machines.get(installation);
        if (!machine?.publicKey) return [];
        return machine.overlapPublicKey
          ? [machine.publicKey, machine.overlapPublicKey]
          : [machine.publicKey];
      },
      friendlyNameFor: (installation) => machines.get(installation)?.friendlyName ?? null,
    },
    error: null,
  };
}

export function holdsMachineLane(roles: MachineRoles | null, lane: Lane): boolean {
  if (!roles) return false;
  return lane === "intake" ? roles.canClaim : roles.here === roles.primary;
}

function ownsIssueLease(here: Installation, issue: number | null, lease: Lease | null): boolean {
  return (
    lease?.installation === here &&
    !lease.released &&
    lease.protocol === LEAN_PROTOCOL_MAJOR &&
    lease.issue === issue &&
    lease.branch === `factory/issue-${issue}`
  );
}

/** The caller supplies fresh lease evidence and checks that the project is active. */
export function allowsMachineAction(
  roles: MachineRoles | null,
  action: DispatchAction,
  lease: Lease | null,
  /** Fresh lease-adapter observation. Acquire must recheck expiry, head and compare-and-swap. */
  claimReclaimable = false,
): boolean {
  if (!roles) return false;
  const primary = roles.here === roles.primary;
  const ownLease = "issue" in action && ownsIssueLease(roles.here, action.issue, lease);
  const canBuild = roles.canClaim && ownLease;
  switch (action.kind) {
    case "claim":
      return canAcquireClaim(roles, action.issue, lease, ownLease, claimReclaimable);
    case "renew-lease":
    case "send-go":
    case "send-repair":
      return canBuild;
    case "release-lease":
      return ownLease && action.why !== "takeover";
    case "open-runner":
      return action.role === "lead" ? canBuild : primary;
    case "merge":
    case "start-delivery":
    case "deliver-send-back":
    case "route":
      return primary;
    case "close-runner":
    case "park":
      return true;
  }
}

function canAcquireClaim(
  roles: MachineRoles,
  issue: number,
  lease: Lease | null,
  ownLease: boolean,
  claimReclaimable: boolean,
): boolean {
  if (!roles.canClaim) return false;
  if (lease === null || ownLease) return true;
  return (
    claimReclaimable &&
    lease.issue === issue &&
    lease.protocol === LEAN_PROTOCOL_MAJOR &&
    lease.branch === `factory/issue-${issue}`
  );
}

/** The signed claim snapshot returned by the lease adapter for this issue and PR head. */
export interface VerifiedMachineSubmission {
  readonly revision: string;
  readonly record: {
    readonly installation: Installation;
    readonly released: boolean;
    readonly submission: { readonly head: string; readonly builderProviderType: string } | null;
  };
}

/** The GitHub adapter has already checked branch head and lease liveness on this reader's clock. */
export function eligibleForeignReview(
  roles: MachineRoles | null,
  issue: number,
  evidence: MergeEvidence,
  verifiedSubmission: VerifiedMachineSubmission | null,
): evidence is OpenEvidence & { lease: Lease } {
  if (!roles || roles.here !== roles.primary || evidence.kind !== "open") return false;
  const { lease, pull, trust, blocked, ownerOnly, checksHeadSha } = evidence;
  return (
    lease !== null &&
    submissionMatches(verifiedSubmission, lease, pull.headSha) &&
    lease.installation !== roles.here &&
    lease.issue === issue &&
    !lease.released &&
    lease.protocol === LEAN_PROTOCOL_MAJOR &&
    lease.branch === `factory/issue-${issue}` &&
    pull.branch === lease.branch &&
    pull.sameRepo &&
    pull.targetsDefaultBranch &&
    trust.trusted &&
    !blocked &&
    ownerOnly.checkedHeadSha === pull.headSha &&
    ownerOnly.touched.length === 0 &&
    checksHeadSha === pull.headSha &&
    pull.checks === "passing"
  );
}

function submissionMatches(
  snapshot: VerifiedMachineSubmission | null,
  lease: Lease,
  head: string,
): boolean {
  return (
    Boolean(snapshot?.revision) &&
    snapshot?.record.installation === lease.installation &&
    !snapshot.record.released &&
    snapshot.record.submission?.head === head &&
    Boolean(snapshot.record.submission.builderProviderType.trim())
  );
}

export type ReviewIndependence =
  | "different-provider"
  | "same-account-recorded"
  | "unverified-foreign";

/** For a verified foreign submission and a clean, locally bound reviewer of the pinned provider. */
export function foreignReviewIndependence(
  submission: { readonly builderProviderType?: string },
  reviewerProviderType: string,
  recordedAccountExclusions: boolean,
  allowSameProvider = true,
): Exclude<ReviewIndependence, "same-account-recorded"> | null {
  if (!reviewerProviderType.trim()) return null;
  if (
    submission.builderProviderType?.trim() &&
    submission.builderProviderType !== reviewerProviderType
  )
    return "different-provider";
  return allowSameProvider && recordedAccountExclusions ? "unverified-foreign" : null;
}

/** The reviewer record comes from the local daemon ledger for this issue and reviewed head. */
export function localReview(
  roles: MachineRoles | null,
  reviewer: RunnerRef | null,
  verdict: Verdict | null,
  reviewedHead: string,
  configuredReviewerProvider: string | null,
): boolean {
  return (
    roles !== null &&
    roles.primary === roles.here &&
    reviewer?.role === "reviewer" &&
    Boolean(configuredReviewerProvider?.trim()) &&
    reviewer.providerType === configuredReviewerProvider &&
    verdict?.source === "local-runner" &&
    verdict.sha === reviewedHead &&
    verdict.reviewer.agentId === reviewer.agentId &&
    verdict.reviewer.providerType === configuredReviewerProvider
  );
}

/** Machine identity is independent of the daemon or Dev connection that runs an agent. */
export interface InstallationBadge {
  installation: Installation;
  friendlyName: string | null;
  role: "primary" | "secondary" | null;
  here: boolean;
}

export function installationBadge(
  roles: MachineRoles | null,
  here: Installation,
  installation: Installation,
  localNames?: ReadonlyMap<Installation, string>,
): InstallationBadge {
  const role = installation === roles?.primary ? "primary" : "secondary";
  return {
    installation,
    friendlyName:
      localNames?.get(installation)?.trim() || roles?.friendlyNameFor(installation) || null,
    role: roles ? role : null,
    here: installation === here,
  };
}
