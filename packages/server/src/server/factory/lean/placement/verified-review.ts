import { createHash } from "node:crypto";
import type { RunnerRef, Verdict } from "../types.js";

export interface VerifiedReviewHost {
  installationId: string;
  installation: string;
  repository: string;
  projectId: string;
  /** The Dev connection saved by this primary Host. */
  devServerId: string;
}

export interface VerifiedReviewTarget {
  issue: number;
  claimInstallation: string;
  claimGeneration: string;
  headSha: string;
  remoteProjectId: string;
  workspaceId: string;
}

/** Authenticated result of the Host lifecycle verifier. Labels and PR fields carry no authority. */
export interface ReviewAssignment {
  installationId: string;
  installation: string;
  claimInstallation: string;
  repository: string;
  projectId: string;
  serverId: string;
  remoteProjectId: string;
  workspaceId: string;
  issue: number;
  generation: string;
  role: "lead" | "reviewer";
  branch: string;
  headSha: string;
  creationKey: string;
  agentId: string;
  provider: string;
}

export type VerifyReviewAssignment = (agentId: string) => Promise<ReviewAssignment | null>;

export type VerifiedReviewerPlacement = Readonly<
  VerifiedReviewHost &
    VerifiedReviewTarget & {
      kind: "verified-primary-dev-reviewer";
      creationKey: string;
      agentId: string;
      provider: string;
      providerType: string;
      accountDefinition: string;
      openedAt: string;
      attempt: number;
    }
>;

export interface VerifiedReviewerVerdict {
  readonly kind: "verified-primary-dev-verdict";
  readonly placementDigest: string;
  readonly verdictDigest: string;
}

function assignmentMatches(
  assignment: ReviewAssignment | null,
  placement: Omit<VerifiedReviewerPlacement, "creationKey">,
): assignment is ReviewAssignment {
  return (
    assignment?.role === "reviewer" &&
    assignment.installationId === placement.installationId &&
    assignment.installation === placement.installation &&
    assignment.claimInstallation === placement.claimInstallation &&
    assignment.repository === placement.repository &&
    assignment.projectId === placement.projectId &&
    assignment.serverId === placement.devServerId &&
    assignment.remoteProjectId === placement.remoteProjectId &&
    assignment.workspaceId === placement.workspaceId &&
    assignment.issue === placement.issue &&
    assignment.generation === placement.claimGeneration &&
    assignment.branch === `factory/issue-${placement.issue}` &&
    assignment.headSha === placement.headSha &&
    assignment.agentId === placement.agentId &&
    assignment.provider === placement.provider &&
    Boolean(assignment.creationKey)
  );
}

function runnerMatches(placement: VerifiedReviewerPlacement, reviewer: RunnerRef): boolean {
  return (
    reviewer.role === "reviewer" &&
    reviewer.serverId === placement.devServerId &&
    reviewer.agentId === placement.agentId &&
    reviewer.account === placement.provider &&
    reviewer.accountDefinition === placement.accountDefinition &&
    reviewer.providerType === placement.providerType &&
    reviewer.openedAt === placement.openedAt &&
    reviewer.attempt === placement.attempt
  );
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function placementDigest(placement: VerifiedReviewerPlacement): string {
  return digest([
    placement.kind,
    placement.installationId,
    placement.installation,
    placement.repository,
    placement.projectId,
    placement.devServerId,
    placement.remoteProjectId,
    placement.workspaceId,
    placement.issue,
    placement.claimInstallation,
    placement.claimGeneration,
    placement.headSha,
    placement.creationKey,
    placement.agentId,
    placement.provider,
    placement.providerType,
    placement.accountDefinition,
    placement.openedAt,
    placement.attempt,
  ]);
}

export function reviewerVerdictDigest(verdict: Verdict): string {
  return digest([
    "factory-dev-review-verdict-v1",
    verdict.sha,
    verdict.approved,
    verdict.findings,
    verdict.source,
    verdict.reviewer.agentId,
    verdict.reviewer.role,
    verdict.reviewer.serverId,
    verdict.reviewer.account,
    verdict.reviewer.accountDefinition,
    verdict.reviewer.providerType,
    verdict.reviewer.openedAt,
    verdict.reviewer.attempt,
  ]);
}

/** The target comes from the Host's launch reservation and the Host-observed claim. */
export async function captureVerifiedReviewerPlacement(input: {
  host: VerifiedReviewHost;
  target: VerifiedReviewTarget;
  reviewer: RunnerRef;
  verifyAssignment: VerifyReviewAssignment;
}): Promise<VerifiedReviewerPlacement | null> {
  const { host, target, reviewer } = input;
  const [hostServer, projectId, extra] = host.installation.split("/");
  if (
    !host.installationId ||
    !hostServer ||
    projectId !== host.projectId ||
    extra !== undefined ||
    !host.devServerId ||
    host.devServerId === hostServer ||
    reviewer.role !== "reviewer" ||
    reviewer.serverId !== host.devServerId ||
    !reviewer.account ||
    !reviewer.accountDefinition ||
    !reviewer.providerType ||
    !target.claimGeneration ||
    !target.claimInstallation ||
    !target.remoteProjectId ||
    !target.workspaceId
  )
    return null;
  const placement = {
    kind: "verified-primary-dev-reviewer" as const,
    ...host,
    ...target,
    agentId: reviewer.agentId,
    provider: reviewer.account,
    accountDefinition: reviewer.accountDefinition,
    providerType: reviewer.providerType,
    openedAt: reviewer.openedAt,
    attempt: reviewer.attempt,
  };
  const assignment = await input.verifyAssignment(placement.agentId);
  if (!assignmentMatches(assignment, placement)) return null;
  return Object.freeze({ ...placement, creationKey: assignment.creationKey });
}

/** Capture while the assignment is live. Persist the receipt with the parsed local verdict. */
export async function captureVerifiedReviewerVerdict(input: {
  placement: VerifiedReviewerPlacement;
  reviewer: RunnerRef;
  verifyAssignment: VerifyReviewAssignment;
  readVerdict(placement: VerifiedReviewerPlacement): Promise<Verdict | null>;
}): Promise<{ verdict: Verdict; verifiedVerdict: VerifiedReviewerVerdict } | null> {
  const placement = Object.freeze({ ...input.placement });
  if (!runnerMatches(placement, input.reviewer)) return null;
  async function assignmentStillBound() {
    const assignment = await input.verifyAssignment(placement.agentId);
    return (
      assignmentMatches(assignment, placement) && assignment.creationKey === placement.creationKey
    );
  }
  if (!(await assignmentStillBound())) return null;
  const candidate = await input.readVerdict(placement);
  if (!candidate) return null;
  const verdict = structuredClone(candidate);
  if (
    verdict.source !== "local-runner" ||
    verdict.sha !== placement.headSha ||
    !runnerMatches(placement, verdict.reviewer) ||
    !(await assignmentStillBound())
  )
    return null;
  const verifiedVerdict = Object.freeze({
    kind: "verified-primary-dev-verdict" as const,
    placementDigest: placementDigest(placement),
    verdictDigest: reviewerVerdictDigest(verdict),
  });
  return { verdict, verifiedVerdict };
}

/** Validation during merge and recovery uses only the primary's retained, private evidence. */
export function verifiedReviewerRefusal(input: {
  host: VerifiedReviewHost | undefined;
  issue: number;
  headSha: string;
  generation: string;
  claimInstallation: string;
  reviewer: RunnerRef;
  verdict: Verdict;
  placement: VerifiedReviewerPlacement | undefined;
  proof: VerifiedReviewerVerdict | undefined;
}): string | null {
  const { host, issue, headSha, generation, reviewer, verdict, placement, proof } = input;
  if (
    !host ||
    placement?.kind !== "verified-primary-dev-reviewer" ||
    proof?.kind !== "verified-primary-dev-verdict"
  ) {
    return "Verify the remote Reviewer through the primary Host's Dev lifecycle.";
  }
  if (
    placement.installationId !== host.installationId ||
    placement.installation !== host.installation ||
    placement.devServerId !== host.devServerId ||
    placement.projectId !== host.projectId ||
    placement.repository !== host.repository
  ) {
    return "The Reviewer placement does not match this primary Host, project, repository or bound Dev.";
  }
  if (
    placement.issue !== issue ||
    placement.claimInstallation !== input.claimInstallation ||
    placement.claimGeneration !== generation ||
    placement.headSha !== headSha
  ) {
    return "The Reviewer placement does not match the claim generation and exact pull request head.";
  }
  if (!runnerMatches(placement, reviewer) || !runnerMatches(placement, verdict.reviewer)) {
    return "The Reviewer agent, account or provider changed after its verified placement.";
  }
  if (
    proof.placementDigest !== placementDigest(placement) ||
    proof.verdictDigest !== reviewerVerdictDigest(verdict)
  ) {
    return "The recorded verdict does not match the verified Reviewer workspace and placement.";
  }
  return null;
}
