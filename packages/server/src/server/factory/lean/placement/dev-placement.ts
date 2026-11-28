import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DevRunnerOptions, DevRunnerPlacement } from "./dev-runners.js";

export type DevCheckoutClient = Pick<DaemonClient, "fetchWorkspaces" | "getCheckoutStatus">;

interface DevWorkspaceTarget {
  remoteProjectId: string;
  workspaceId: string;
  cwd: string;
  branch: string;
  checkoutBranch: string;
  repository: string;
  issueTitle?: string;
}

interface DevIssueAuthority {
  repository: string;
  claimInstallation: string;
  generation: string;
  pushedHeadSha: string;
  reviewerHeadSha: string | null;
  planRevision: string | null;
  approvedPaths: readonly string[];
}

type VerifyInput = Parameters<DevRunnerOptions["verifyPlacement"]>[0];
type AuthorityInput = Omit<VerifyInput, "client">;

export interface DevPlacementOptions {
  reviewBranch(issue: number, head: string, generation: string): string;
  /** Host-owned policy, current claim and plan, and independently fetched GitHub head. */
  readIssueAuthority(input: AuthorityInput): Promise<DevIssueAuthority | null>;
  /** The registered checkout in the owner-approved Dev project mirror. */
  resolveWorkspace(
    input: VerifyInput,
    authority: DevIssueAuthority,
  ): Promise<DevWorkspaceTarget | null>;
}

export function createDevPlacementVerifier(
  options: DevPlacementOptions,
): DevRunnerOptions["verifyPlacement"] {
  return async (input): Promise<DevRunnerPlacement | null> => {
    const { client, ...authorityInput } = input;
    const authority = await options.readIssueAuthority(authorityInput);
    if (!authority) return null;
    const target = await options.resolveWorkspace(input, authority);
    if (!target || target.repository !== authority.repository) return null;
    if (
      input.role === "reviewer" &&
      (!authority.reviewerHeadSha ||
        target.checkoutBranch !==
          options.reviewBranch(input.issue, authority.reviewerHeadSha, authority.generation))
    )
      return null;
    const checkout = await readDevCheckout(client, target, input.role);
    if (
      !checkout ||
      !isDeepStrictEqual(authority, await options.readIssueAuthority(authorityInput))
    )
      return null;
    if (
      input.role === "reviewer" &&
      (!checkout.clean ||
        checkout.headSha !== authority.reviewerHeadSha ||
        checkout.headSha !== authority.pushedHeadSha)
    )
      return null;
    return {
      ...target,
      ...checkout,
      claimInstallation: authority.claimInstallation,
      generation: authority.generation,
      pushedHeadSha: authority.pushedHeadSha,
      planRevision: authority.planRevision,
      approvedPaths: [...authority.approvedPaths],
    };
  };
}

const oid = /^[a-f0-9]{40}$/u;

export async function readDevCheckout(
  client: DevCheckoutClient,
  target: DevWorkspaceTarget,
  role: "lead" | "reviewer",
): Promise<{ headSha: string; clean: boolean } | null> {
  if (!(await registeredWorktree(client, target))) return null;
  const observe = { requestId: randomUUID(), observeHead: true as const };
  const checkout: Awaited<ReturnType<DevCheckoutClient["getCheckoutStatus"]>> & {
    observedHead?: string;
  } = await client.getCheckoutStatus(target.cwd, observe);
  if (checkout.error || !checkout.isGit || !checkout.isPaseoOwnedWorktree) return null;
  const remote =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+)$/iu
      .exec(checkout.remoteUrl ?? "")?.[1]
      ?.replace(/\.git$/iu, "");
  if (
    role === "lead"
      ? target.checkoutBranch !== target.branch
      : target.checkoutBranch === target.branch
  )
    return null;
  if (
    checkout.repoRoot !== target.cwd ||
    checkout.currentBranch !== target.checkoutBranch ||
    remote?.toLowerCase() !== target.repository.toLowerCase() ||
    !checkout.observedHead ||
    !oid.test(checkout.observedHead)
  )
    return null;
  return { headSha: checkout.observedHead, clean: !checkout.isDirty };
}

async function registeredWorktree(
  client: DevCheckoutClient,
  target: DevWorkspaceTarget,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.fetchWorkspaces({
      filter: { projectId: target.remoteProjectId },
      page: { limit: 200, cursor },
    });
    const workspace = result.entries.find(({ id }) => id === target.workspaceId);
    if (workspace) {
      return (
        workspace.workspaceKind === "worktree" &&
        workspace.projectId === target.remoteProjectId &&
        workspace.workspaceDirectory === target.cwd
      );
    }
    const next = result.pageInfo?.nextCursor;
    if (!result.pageInfo?.hasMore || !next || next === cursor) return false;
    cursor = next;
  }
  return false;
}
