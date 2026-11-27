import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MergeEvidence } from "../merge-gate.js";
import { signMachinePayload, verifyMachinePayload } from "./host-key.js";
import { LEAN_PROTOCOL_MAJOR, type Lease, type RunnerRef, type Verdict } from "../types.js";
import {
  allowsMachineAction,
  eligibleForeignReview,
  foreignReviewIndependence,
  holdsMachineLane,
  installationBadge,
  localReview,
  resolveMachineRoles,
} from "./roles.js";

const primary = "primary/project";
const secondary = "secondary/project";
const config = { version: 1, mode: "lean" as const, order: [primary] };
const primaryRoles = resolveMachineRoles(config, primary).roles;
const secondaryRoles = resolveMachineRoles(config, secondary).roles;
const head = "a".repeat(40);
const now = "2026-11-27T20:00:00Z";
const lease: Lease = {
  issue: 42,
  installation: secondary,
  branch: "factory/issue-42",
  renewedAt: now,
  seenUnchangedSince: now,
  expiresAt: "2026-11-27T22:00:00Z",
  protocol: LEAN_PROTOCOL_MAJOR,
  released: false,
};
const submission = {
  revision: "claim-ref-revision",
  record: {
    installation: secondary,
    released: false,
    submission: { head, builderProviderType: "codex" },
  },
};
const evidence: Extract<MergeEvidence, { kind: "open" }> = {
  kind: "open",
  pull: {
    number: 73,
    headSha: head,
    checks: "passing",
    branch: lease.branch,
    sameRepo: true,
    targetsDefaultBranch: true,
  },
  trust: { trusted: true },
  blocked: false,
  lease,
  ownerOnly: { checkedHeadSha: head, touched: [] },
  checksHeadSha: head,
  trustedThreadsOpen: 0,
  mergeable: true,
  lead: null,
  reviewer: null,
  verdict: null,
  acceptance: null,
  acceptanceSession: null,
};

describe("fixed primary machine roles", () => {
  it("fails closed without one valid primary or with a lane override", () => {
    for (const invalid of [
      null,
      { version: 1 },
      { ...config, order: [] },
      { ...config, order: [primary, secondary] },
      { ...config, order: ["bad-id"] },
      { ...config, lanes: { merge: secondary } },
      { ...config, version: 2 },
    ]) {
      expect(resolveMachineRoles(invalid, secondary).roles).toBeNull();
    }
    expect(resolveMachineRoles({ ...config, order: [] }, primary).error).toContain("exactly one");
    expect(resolveMachineRoles({ ...config, mode: "crew" }, primary).roles).toBeNull();
    expect(resolveMachineRoles(config, "bad-id").roles).toBeNull();
  });

  it("resolves only Ed25519 public keys listed in the accepted configuration", () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const machines = { [secondary]: { publicKey, friendlyName: "  Studio  " } };
    const { roles } = resolveMachineRoles({ ...config, machines }, primary);
    expect(roles?.publicKeyFor(secondary)).toBe(publicKey);
    expect(roles?.publicKeyFor(primary)).toBeNull();
    expect(installationBadge(roles, primary, secondary).friendlyName).toBe("Studio");
    const aliases = new Map([[secondary, "Lab Studio"]]);
    expect(installationBadge(roles, primary, secondary, aliases).friendlyName).toBe("Lab Studio");
    const bad = { [secondary]: { publicKey: "not an Ed25519 public key" } };
    expect(resolveMachineRoles({ ...config, machines: bad }, primary).roles).toBeNull();
  });

  it("accepts both enrolled keys during overlap and drops the old key after removal", () => {
    const old = generateKeyPairSync("ed25519");
    const next = generateKeyPairSync("ed25519");
    const publicKey = old.publicKey.export({ type: "spki", format: "pem" }).toString();
    const overlapPublicKey = next.publicKey.export({ type: "spki", format: "pem" }).toString();
    const resolveKeys = (machine: { publicKey: string; overlapPublicKey?: string }) =>
      resolveMachineRoles({ ...config, machines: { [secondary]: machine } }, primary);
    const payload = Buffer.from("pinned Factory batch");
    const oldSignature = signMachinePayload(old.privateKey, payload);
    const newSignature = signMachinePayload(next.privateKey, payload);
    const accepts = (keys: readonly string[] | undefined, signature: string) =>
      keys?.some((key) => verifyMachinePayload(key, payload, signature));

    const overlap = resolveKeys({ publicKey, overlapPublicKey }).roles?.publicKeysFor(secondary);
    expect(accepts(overlap, oldSignature)).toBe(true);
    expect(accepts(overlap, newSignature)).toBe(true);
    const rotated = resolveKeys({ publicKey: overlapPublicKey }).roles?.publicKeysFor(secondary);
    expect(accepts(rotated, oldSignature)).toBe(false);
    expect(accepts(rotated, newSignature)).toBe(true);
    expect(
      resolveKeys({ publicKey, overlapPublicKey: publicKey.replaceAll("\n", "\r\n") }).roles,
    ).toBeNull();
    expect(resolveKeys({ publicKey, overlapPublicKey: "invalid" }).roles).toBeNull();
  });

  it("allows secondary intake and reserves project lanes for the primary", () => {
    expect(holdsMachineLane(secondaryRoles, "intake")).toBe(true);
    const restricted = { ...config, claimers: [secondary] };
    expect(holdsMachineLane(resolveMachineRoles(restricted, primary).roles, "intake")).toBe(false);
    for (const lane of ["merge", "delivery", "releaseBuild", "mechanic"] as const) {
      expect(holdsMachineLane(resolveMachineRoles(restricted, primary).roles, lane)).toBe(true);
      expect(holdsMachineLane(secondaryRoles, lane)).toBe(false);
    }
  });

  it("keeps builder dispatch and lease writes with the lease holder", () => {
    const claim = { kind: "claim", issue: 42 } as const;
    const lead = { kind: "open-runner", issue: 42, role: "lead", reason: "", brief: "" } as const;
    const release = { kind: "release-lease", issue: 42, why: "done" } as const;
    expect(allowsMachineAction(secondaryRoles, claim, null)).toBe(true);
    expect(allowsMachineAction(primaryRoles, claim, lease)).toBe(false);
    expect(allowsMachineAction(primaryRoles, claim, lease, true)).toBe(true);
    expect(allowsMachineAction(primaryRoles, claim, { ...lease, issue: 43 }, true)).toBe(false);
    expect(allowsMachineAction(secondaryRoles, lead, lease)).toBe(true);
    expect(allowsMachineAction(primaryRoles, lead, lease)).toBe(false);
    expect(allowsMachineAction(secondaryRoles, lead, { ...lease, issue: 43 })).toBe(false);
    expect(allowsMachineAction(secondaryRoles, release, lease)).toBe(true);
    expect(allowsMachineAction(primaryRoles, release, lease)).toBe(false);
    expect(allowsMachineAction(secondaryRoles, { ...release, why: "takeover" }, lease)).toBe(false);
  });

  it("reserves review and acceptance dispatch for the primary", () => {
    for (const role of ["reviewer", "foreman-op"] as const) {
      const action = { kind: "open-runner", issue: 42, role, reason: "", brief: "" } as const;
      expect(allowsMachineAction(primaryRoles, action, lease)).toBe(true);
      expect(allowsMachineAction(secondaryRoles, action, lease)).toBe(false);
      expect(allowsMachineAction(null, action, lease)).toBe(false);
    }
  });

  it("admits a foreign claim for review only with fresh trusted PR evidence on the primary", () => {
    expect(eligibleForeignReview(primaryRoles, 42, evidence, submission)).toBe(true);
    expect(eligibleForeignReview(secondaryRoles, 42, evidence, submission)).toBe(false);
    expect(eligibleForeignReview(primaryRoles, 42, evidence, null)).toBe(false);
    const stale = {
      ...submission,
      record: {
        ...submission.record,
        submission: { ...submission.record.submission, head: "b".repeat(40) },
      },
    };
    expect(eligibleForeignReview(primaryRoles, 42, evidence, stale)).toBe(false);
    for (const invalid of [
      { lease: null },
      { lease: { ...lease, released: true } },
      { lease: { ...lease, protocol: LEAN_PROTOCOL_MAJOR + 1 } },
      { trust: { trusted: false, reason: "Untrusted issue." } as const },
      { blocked: true },
      { pull: { ...evidence.pull, sameRepo: false } },
      { pull: { ...evidence.pull, targetsDefaultBranch: false } },
      { ownerOnly: { checkedHeadSha: head, touched: [".github/vorteo-factory.json"] } },
      { checksHeadSha: "b".repeat(40) },
    ]) {
      expect(eligibleForeignReview(primaryRoles, 42, { ...evidence, ...invalid }, submission)).toBe(
        false,
      );
    }
  });

  it("binds local review to the exact head, ledger runner and configured provider", () => {
    const reviewer: RunnerRef = {
      agentId: "reviewer",
      role: "reviewer",
      serverId: "dev",
      account: "scratch",
      accountDefinition: "scratch",
      providerType: "codex",
      openedAt: now,
      attempt: 1,
    };
    const verdict: Verdict = {
      sha: head,
      approved: true,
      reviewer,
      findings: null,
      source: "local-runner",
    };
    expect(localReview(primaryRoles, reviewer, verdict, head, "codex")).toBe(true);
    expect(localReview(primaryRoles, reviewer, verdict, head, "claude")).toBe(false);
    expect(localReview(primaryRoles, reviewer, verdict, head, null)).toBe(false);
    expect(localReview(secondaryRoles, reviewer, verdict, head, "codex")).toBe(false);
    expect(localReview(primaryRoles, reviewer, verdict, "b".repeat(40), "codex")).toBe(false);
    expect(
      localReview(primaryRoles, { ...reviewer, agentId: "other" }, verdict, head, "codex"),
    ).toBe(false);
    const imported = { ...verdict, source: { installation: secondary, commentId: 1 } };
    expect(localReview(primaryRoles, reviewer, imported, head, "codex")).toBe(false);
  });

  it("identifies the claim machine separately from the local runner environment", () => {
    expect(
      installationBadge(primaryRoles, primary, secondary, new Map([[secondary, "Studio"]])),
    ).toEqual({
      installation: secondary,
      friendlyName: "Studio",
      role: "secondary",
      here: false,
    });
    expect(installationBadge(null, primary, primary).role).toBeNull();
  });

  it("records foreign same-provider review as unverified only with recorded exclusions", () => {
    const verified = submission.record.submission;
    expect(foreignReviewIndependence(verified, "claude", false)).toBe("different-provider");
    expect(foreignReviewIndependence(verified, "codex", true)).toBe("unverified-foreign");
    expect(foreignReviewIndependence(verified, "codex", false)).toBeNull();
    expect(foreignReviewIndependence(verified, "codex", true, false)).toBeNull();
  });
});
