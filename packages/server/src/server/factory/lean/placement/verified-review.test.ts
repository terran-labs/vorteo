import { describe, expect, it } from "vitest";
import type { RunnerRef, Verdict } from "../types.js";
import {
  captureVerifiedReviewerPlacement,
  captureVerifiedReviewerVerdict,
  verifiedReviewerRefusal,
  type ReviewAssignment,
} from "./verified-review.js";

const host = {
  installationId: "fixture-installation",
  installation: "host/project",
  projectId: "project",
  repository: "owner/repo",
  devServerId: "dev",
};
const target = {
  issue: 7,
  claimInstallation: host.installation,
  claimGeneration: "gen",
  headSha: "a".repeat(40),
  remoteProjectId: "dev-project",
  workspaceId: "review-tree",
};
const reviewer: RunnerRef = {
  agentId: "reviewer",
  role: "reviewer",
  account: "dev-account",
  accountDefinition: "account",
  providerType: "claude",
  attempt: 1,
  openedAt: "2026-11-27T00:00:00Z",
  serverId: "dev",
};
const assignment: ReviewAssignment = {
  ...host,
  ...target,
  serverId: "dev",
  role: "reviewer",
  generation: target.claimGeneration,
  branch: "factory/issue-7",
  creationKey: "create-7",
  agentId: reviewer.agentId,
  provider: "dev-account",
};
const verdict: Verdict = {
  sha: target.headSha,
  approved: true,
  reviewer,
  findings: null,
  source: "local-runner",
};

describe("bound Dev Reviewer reply", () => {
  it("requires the original creation receipt throughout the read and retains exact-head evidence after archive", async () => {
    let current = { ...assignment };
    const verifyAssignment = async () => current;
    const placement = await captureVerifiedReviewerPlacement({
      host,
      target,
      reviewer,
      verifyAssignment,
    });
    if (!placement) throw new Error("Fixture lacked its assigned Reviewer");
    const capture = () =>
      captureVerifiedReviewerVerdict({
        placement,
        reviewer,
        verifyAssignment,
        readVerdict: async () => verdict,
      });
    const proof = (await capture())?.verifiedVerdict;
    const input = {
      host,
      issue: target.issue,
      headSha: target.headSha,
      generation: target.claimGeneration,
      claimInstallation: target.claimInstallation,
      reviewer,
      verdict,
      placement,
      proof,
    };
    expect(verifiedReviewerRefusal(input)).toBeNull();
    expect(verifiedReviewerRefusal({ ...input, headSha: "b".repeat(40) })).toBeTruthy();
    expect(
      verifiedReviewerRefusal({ ...input, host: { ...host, devServerId: "other-dev" } }),
    ).toBeTruthy();
    const raced = await captureVerifiedReviewerVerdict({
      placement,
      reviewer,
      verifyAssignment,
      readVerdict: async () => {
        current = { ...current, creationKey: "different-create" };
        return verdict;
      },
    });
    expect(raced).toBeNull();
  });
});
