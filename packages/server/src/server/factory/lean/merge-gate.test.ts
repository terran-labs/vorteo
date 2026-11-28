import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMergeGate,
  type MergeEvidence,
  type MergeGateDeps,
  type MergeIntent,
} from "./merge-gate.js";
import { createLeanDeliveryHostGate } from "./delivery-host-gate.js";
import { emptyLedger } from "./state.js";
import { LEAN_PROTOCOL_MAJOR, type RunnerRef } from "./types.js";

const headSha = "a".repeat(40);
const nextHead = "b".repeat(40);
const mergeSha = "c".repeat(40);
const here = "server/project";
const now = "2026-11-27T20:00:00Z";

function runner(role: RunnerRef["role"], accountDefinition: string): RunnerRef {
  return {
    agentId: role,
    role,
    serverId: null,
    account: accountDefinition,
    accountDefinition,
    providerType: "codex",
    openedAt: now,
    attempt: 1,
  };
}

function openEvidence(): Extract<MergeEvidence, { kind: "open" }> {
  const reviewer = runner("reviewer", "second");
  const acceptanceSession = runner("foreman-op", "third");
  return {
    kind: "open",
    pull: {
      number: 19,
      headSha,
      checks: "passing",
      branch: "factory/issue-7",
      sameRepo: true,
      targetsDefaultBranch: true,
    },
    trust: { trusted: true },
    blocked: false,
    lease: {
      issue: 7,
      branch: "factory/issue-7",
      installation: here,
      renewedAt: now,
      expiresAt: "2026-11-27T21:00:00Z",
      seenUnchangedSince: now,
      protocol: LEAN_PROTOCOL_MAJOR,
      released: false,
    },
    ownerOnly: { checkedHeadSha: headSha, touched: [] },
    checksHeadSha: headSha,
    trustedThreadsOpen: 0,
    mergeable: true,
    lead: runner("lead", "first"),
    reviewer,
    verdict: { sha: headSha, approved: true, reviewer, findings: null, source: "local-runner" },
    acceptance: {
      sha: headSha,
      outcome: "accepted",
      improvements: [],
      session: acceptanceSession.agentId,
      source: "local-session",
      at: now,
    },
    acceptanceSession,
  };
}

function fixture() {
  const open = openEvidence();
  const state: {
    evidence: MergeEvidence;
    fence: boolean;
    epoch: number | null;
    events: unknown[][];
    intent: MergeIntent | null;
  } = {
    evidence: open,
    fence: true,
    epoch: 4,
    events: [],
    intent: null,
  };
  const merged: MergeEvidence = { kind: "merged", pull: open.pull, mergeSha };
  const deps: MergeGateDeps = {
    here,
    async read() {
      return state.evidence;
    },
    async currentMergeEpoch() {
      return state.epoch;
    },
    async fenceMerge(epoch) {
      state.events.push(["fence", epoch]);
      return state.fence && epoch === state.epoch;
    },
    async submit(target) {
      state.events.push(["submit", target]);
      state.evidence = merged;
      return { kind: "submitted" };
    },
    async readIntent() {
      return state.intent;
    },
    async recordIntent(intent, epoch) {
      state.events.push(["record-intent", epoch]);
      state.intent = structuredClone(intent);
      return { done: true };
    },
    async complete(target) {
      state.events.push(["complete", target]);
      return { done: true };
    },
  };
  return { open, state, merged, deps, gate: createMergeGate(deps) };
}

type OpenEvidence = ReturnType<typeof openEvidence>;
const refusals: Array<[string, (evidence: OpenEvidence) => void]> = [
  [
    "untrusted issue",
    (e) => {
      e.trust = { trusted: false, reason: "Reapprove the issue." };
    },
  ],
  [
    "fork",
    (e) => {
      e.pull.sameRepo = false;
    },
  ],
  [
    "wrong claim branch",
    (e) => {
      e.pull.branch = "factory/issue-8";
    },
  ],
  [
    "wrong base",
    (e) => {
      e.pull.targetsDefaultBranch = false;
    },
  ],
  [
    "missing live lease",
    (e) => {
      e.lease = null;
    },
  ],
  [
    "owner-only change",
    (e) => {
      e.ownerOnly.touched = [".github/vorteo-factory.json"];
    },
  ],
  [
    "stale owner-only scan",
    (e) => {
      e.ownerOnly.checkedHeadSha = nextHead;
    },
  ],
  [
    "stale checks",
    (e) => {
      e.checksHeadSha = nextHead;
    },
  ],
  [
    "failing checks",
    (e) => {
      e.pull.checks = "failing";
    },
  ],
  [
    "Factory block",
    (e) => {
      e.blocked = true;
    },
  ],
  [
    "trusted review thread",
    (e) => {
      e.trustedThreadsOpen = 1;
    },
  ],
  [
    "unknown mergeability",
    (e) => {
      e.mergeable = null;
    },
  ],
  [
    "account aliases for the same definition",
    (e) => {
      e.reviewer = {
        ...runner("reviewer", "first"),
        account: "different-local-id",
        serverId: "dev",
      };
    },
  ],
  [
    "unbound reviewer",
    (e) => {
      e.reviewer = { ...runner("reviewer", "second"), agentId: "other" };
    },
  ],
  [
    "unknown reviewer account",
    (e) => {
      e.reviewer = { ...runner("reviewer", "second"), accountDefinition: null };
    },
  ],
  [
    "marker verdict",
    (e) => {
      if (e.verdict) e.verdict.source = { installation: here, commentId: 1 };
    },
  ],
  [
    "stale verdict",
    (e) => {
      if (e.verdict) e.verdict.sha = nextHead;
    },
  ],
  [
    "rejected verdict",
    (e) => {
      if (e.verdict) e.verdict.approved = false;
    },
  ],
  [
    "sent-back acceptance",
    (e) => {
      if (e.acceptance) e.acceptance.outcome = "sent-back";
    },
  ],
  [
    "stale acceptance",
    (e) => {
      if (e.acceptance) e.acceptance.sha = nextHead;
    },
  ],
  [
    "unbound Foreman session",
    (e) => {
      e.acceptanceSession = null;
    },
  ],
  [
    "marker acceptance",
    (e) => {
      if (e.acceptance) e.acceptance.source = { installation: here, commentId: 1 };
    },
  ],
  ...["lead", "reviewer"].map<[string, (evidence: OpenEvidence) => void]>((role) => [
    `Foreman session reused the ${role} agent`,
    (e) => {
      e.acceptanceSession = { ...runner("foreman-op", "third"), agentId: role };
      if (e.acceptance) e.acceptance.session = role;
    },
  ]),
];

describe("Lean Factory merge gate", () => {
  it("accepts a fresh same-account Reviewer only with the recorded exclusion of alternatives", async () => {
    const { open, gate } = fixture();
    const reviewer = runner("reviewer", "first");
    open.reviewer = reviewer;
    open.verdict!.reviewer = reviewer;
    open.reviewAccountSelection = {
      mode: "same-account",
      issue: 7,
      headSha,
      at: now,
      builderAgentId: "lead",
      builderAccount: "first",
      builderAccountDefinition: "first",
      reviewerAgentId: "reviewer",
      reviewerAccount: "first",
      reviewerAccountDefinition: "first",
      daemonCreated: true,
      clean: true,
      nonChild: true,
      freshSession: true,
      candidates: [
        { account: "first", accountDefinition: "first", reason: "selected" },
        { account: "second", accountDefinition: "second", reason: "exhausted" },
      ],
    };
    expect((await gate.evaluate(7)).ready).toBe(true);
    open.reviewAccountSelection.candidates[1].reason = "unknown";
    expect((await gate.evaluate(7)).ready).toBe(false);
    const alternate = open.reviewAccountSelection.candidates[1];
    alternate.reason = "below-floor";
    expect((await gate.evaluate(7)).ready).toBe(false);
    alternate.evidence = {
      provider: "second",
      installationDefinitionId: "second",
      accountRef: "second",
      eligibility: "known-low",
      windows: [],
      floorPct: 25,
      reservedHeadroomPct: 0,
      remainingPct: 20,
      capacity: null,
      readingAgeMs: 0,
      exclusionReason: "quota-below-floor",
      earliestResetAt: null,
    };
    expect((await gate.evaluate(7)).ready).toBe(true);
  });
  it.each(refusals)("refuses %s at evaluation and at execution", async (_name, change) => {
    const { gate, open, state } = fixture();
    const decision = await gate.evaluate(7);
    if (!decision.ready) throw new Error(decision.waitingOn);
    change(open);
    expect(await gate.evaluate(7)).toMatchObject({ ready: false });
    expect(await gate.merge(7, decision.pr, decision.verdict, decision.acceptance)).toHaveProperty(
      "refused",
    );
    expect(state.events).toEqual([]);
  });

  it("pins submission to the exact approved head and fences before each operation", async () => {
    const { gate, state } = fixture();
    const decision = await gate.evaluate(7);
    if (!decision.ready) throw new Error(decision.waitingOn);
    expect(await gate.merge(7, decision.pr, decision.verdict, decision.acceptance)).toEqual({
      mergeSha,
    });
    const target = { issue: 7, number: 19, headSha };
    expect(state.events).toEqual([
      ["fence", 4],
      ["record-intent", 4],
      ["fence", 4],
      ["submit", target],
      ["fence", 4],
      ["complete", { ...target, mergeSha, epoch: 4 }],
    ]);
  });

  it.each(["head moved", "lease lost", "wrong pull request"])(
    "skips submission when %s",
    async (reason) => {
      const { gate, open, state } = fixture();
      const decision = await gate.evaluate(7);
      if (!decision.ready) throw new Error(decision.waitingOn);
      if (reason === "head moved") open.pull.headSha = nextHead;
      if (reason === "lease lost") state.fence = false;
      if (reason === "wrong pull request") open.pull.number += 1;
      expect(
        await gate.merge(7, decision.pr, decision.verdict, decision.acceptance),
      ).toHaveProperty("refused");
      expect(state.events.filter(([name]) => name === "submit")).toEqual([]);
    },
  );

  it("refuses submission when pre-submit intent cannot be persisted", async () => {
    const { deps, state } = fixture();
    deps.recordIntent = async () => ({ done: false, reason: "An approval already exists." });
    const gate = createMergeGate(deps);
    const decision = await gate.evaluate(7);
    if (!decision.ready) throw new Error(decision.waitingOn);
    expect(await gate.merge(7, decision.pr, decision.verdict, decision.acceptance)).toEqual({
      refused: "An approval already exists.",
    });
    expect(state.events).toEqual([["fence", 4]]);
  });

  it.each([
    "missing",
    "wrong issue",
    "wrong PR",
    "wrong head",
    "wrong reviewer",
    "wrong acceptance",
  ])("escalates an already-merged PR with %s durable intent", async (problem) => {
    const { gate, state, deps } = fixture();
    const decision = await gate.evaluate(7);
    if (!decision.ready) throw new Error(decision.waitingOn);
    expect(await gate.merge(7, decision.pr, decision.verdict, decision.acceptance)).toEqual({
      mergeSha,
    });
    const intent = state.intent;
    if (!intent) throw new Error("Expected persisted merge intent.");
    if (problem === "missing") state.intent = null;
    if (problem === "wrong issue") intent.issue += 1;
    if (problem === "wrong PR") intent.number += 1;
    if (problem === "wrong head") intent.headSha = nextHead;
    if (problem === "wrong reviewer") intent.approval.reviewer = null;
    if (problem === "wrong acceptance" && intent.approval.acceptance) {
      intent.approval.acceptance.sha = nextHead;
    }
    state.events.length = 0;
    const restarted = createMergeGate(deps);
    expect(await restarted.recoverMerged(7, decision.pr)).toMatchObject({
      code: "merge-inconsistent",
    });
    expect(
      await restarted.merge(7, decision.pr, decision.verdict, decision.acceptance),
    ).toMatchObject({
      code: "merge-inconsistent",
    });
    expect(state.events).toEqual([]);
  });

  it("waits for the merge queue and recovers the merged head after restart", async () => {
    const { open, state, merged, deps } = fixture();
    deps.submit = async (target) => {
      state.events.push(["submit", target]);
      state.evidence = { kind: "queued", pull: open.pull };
      return { kind: "queued" };
    };
    const gate = createMergeGate(deps);
    const decision = await gate.evaluate(7);
    if (!decision.ready) throw new Error(decision.waitingOn);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await gate.merge(7, decision.pr, decision.verdict, decision.acceptance),
      ).toHaveProperty("refused");
    }
    expect(state.events).toEqual([
      ["fence", 4],
      ["record-intent", 4],
      ["fence", 4],
      ["submit", { issue: 7, number: 19, headSha }],
    ]);

    state.evidence = merged;
    state.events.length = 0;
    const restarted = createMergeGate(deps);
    expect(await restarted.recoverMerged(7, { ...decision.pr, headSha: nextHead })).toHaveProperty(
      "refused",
    );
    expect(state.events).toEqual([]);
    expect(await restarted.recoverMerged(7, decision.pr)).toEqual({ mergeSha });
    expect(state.events).toEqual([
      ["fence", 4],
      ["complete", { issue: 7, number: 19, headSha, mergeSha, epoch: 4 }],
    ]);
    state.events.length = 0;
    expect(await restarted.merge(7, decision.pr, decision.verdict, decision.acceptance)).toEqual({
      mergeSha,
    });
    expect(state.events).toEqual([
      ["fence", 4],
      ["complete", { issue: 7, number: 19, headSha, mergeSha, epoch: 4 }],
    ]);
  });
});

describe("Lean Factory Host delivery checkpoints", () => {
  const checkpoint = "1".repeat(40);
  const intermediate = "2".repeat(40);
  const target = "3".repeat(40);
  const output = "release-notes/betas.tsv";
  const settings = ".github/vorteo-factory.json";
  const repository = "owner/repo";

  function history(options: {
    paths: string[];
    fromIntermediate?: boolean;
    configured?: string;
    delivered?: string;
    receiptPaths?: string[];
    merger?: string;
    addedDelegate?: string;
  }) {
    const ledger = emptyLedger();
    const parent = options.fromIntermediate ? intermediate : checkpoint;
    const routes = new Map<string, unknown>();
    const root = `repos/${repository}`;
    function bind(path: string, body: unknown) {
      routes.set(root + path, body);
    }
    function commit(sha: string, before: string | null, baselineCommit?: string) {
      const tree = createHash("sha1").update(`tree:${sha}`).digest("hex");
      const directory = createHash("sha1").update(`directory:${sha}`).digest("hex");
      const text = JSON.stringify({
        schema: "vorteo-factory",
        version: 1,
        release: {
          baselineCommit,
          identity: "commit",
          records: [output],
          channels: { beta: { tag: "beta" }, stable: { tag: "stable" } },
          steps: {
            deployBeta: { run: "true" },
            verifyBeta: { run: "true" },
            promote: { run: "true" },
            verifyStable: { run: "true" },
            rollback: { kind: "none" },
          },
          gates: { beta: [], stable: [] },
          trigger: { kind: "every-batch" },
        },
      });
      const blob = createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex");
      bind(`/git/commits/${sha}`, {
        sha,
        tree: { sha: tree },
        parents: before ? [{ sha: before }] : [],
      });
      bind(`/git/trees/${tree}`, {
        sha: tree,
        truncated: false,
        tree: [{ path: ".github", mode: "040000", type: "tree", sha: directory }],
      });
      const entries = [{ path: "vorteo-factory.json", mode: "100644", type: "blob", sha: blob }];
      if (sha === target && options.addedDelegate) {
        const delegates = JSON.stringify({ approvers: [options.addedDelegate] });
        const delegateBlob = createHash("sha1")
          .update(`blob ${Buffer.byteLength(delegates)}\0`)
          .update(delegates)
          .digest("hex");
        entries.push({
          path: "delivery-approvers.json",
          mode: "100644",
          type: "blob",
          sha: delegateBlob,
        });
        bind(`/git/blobs/${delegateBlob}`, {
          sha: delegateBlob,
          encoding: "base64",
          content: Buffer.from(delegates).toString("base64"),
        });
      }
      bind(`/git/trees/${directory}`, {
        sha: directory,
        truncated: false,
        tree: entries,
      });
      bind(`/git/blobs/${blob}`, {
        sha: blob,
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
      });
    }
    function diff(before: string, after: string, paths: string[]) {
      bind(`/compare/${before}...${after}?per_page=1`, {
        status: "ahead",
        merge_base_commit: { sha: before },
        files: paths.map((filename) => ({ filename, status: "modified" })),
      });
    }
    commit(checkpoint, null);
    commit(intermediate, checkpoint);
    commit(target, parent, options.configured);
    diff(parent, target, options.paths);
    diff(checkpoint, intermediate, ["src/unattributed.ts"]);
    bind("", {
      full_name: repository,
      default_branch: "main",
      owner: { login: "owner", type: "User" },
    });
    bind("/git/ref/heads/main", { ref: "refs/heads/main", object: { sha: target } });
    bind(`/commits/${target}/pulls?per_page=100`, [{ number: 27, merge_commit_sha: target }]);
    bind("/pulls/27", {
      number: 27,
      merged: true,
      merge_commit_sha: target,
      merged_by: { login: options.merger ?? "owner" },
      base: { ref: "main", repo: { full_name: repository } },
    });
    if (options.delivered || options.receiptPaths) {
      ledger.delivery.receipts.push({
        jobId: "delivery",
        kind: "cut-beta",
        commits: [options.delivered ?? checkpoint],
        target: "beta",
        verifiedAt: now,
        verification: "Exact installed version verified",
        outcome: "delivered",
        laneEpoch: 1,
        notesUrl: null,
        ...(options.receiptPaths
          ? { records: { commit: target, parent, paths: options.receiptPaths } }
          : {}),
      });
    }
    return createLeanDeliveryHostGate({
      repository,
      projectId: "project",
      initialDeliveredCommit: checkpoint,
      state: {
        async read() {
          return ledger;
        },
        async mutate() {
          throw new Error("Host gate wrote state");
        },
      },
      github: {
        async rest(method, route) {
          if (method !== "GET") throw new Error("Host gate wrote GitHub");
          return { status: routes.has(route) ? 200 : 404, body: routes.get(route) };
        },
      },
    });
  }

  it.each([
    { name: "a trusted settings-only PR", paths: [settings], passed: true },
    {
      name: "a daemon-owned delivery record",
      paths: [output],
      receiptPaths: [output],
      passed: true,
    },
    {
      name: "settings plus an unrelated change",
      paths: [settings, "src/hidden.ts"],
      passed: false,
    },
    {
      name: "a settings PR merged by an untrusted account",
      paths: [settings],
      merger: "unknown",
      passed: false,
    },
    {
      name: "a settings PR granting the merger their own trust",
      paths: [".github/delivery-approvers.json"],
      merger: "new-user",
      addedDelegate: "new-user",
      passed: false,
    },
    {
      name: "a delivery output receipt for the wrong paths",
      paths: [output, "src/hidden.ts"],
      receiptPaths: [output],
      passed: false,
    },
  ])("checks $name on first-parent history", async ({ passed, ...options }) => {
    const result = await history(options)(target);
    expect(result?.trust).toEqual({ passed, sha: target });
    expect(result?.ownerOnly.passed).toBe(passed);
    if (!passed) expect(result?.reason).toContain(target.slice(0, 12));
  });

  it("uses the newer trusted checkpoint and cannot rewind to a stale setting", async () => {
    const newerOwner = history({
      paths: [settings],
      fromIntermediate: true,
      configured: intermediate,
      delivered: checkpoint,
    });
    expect(await newerOwner(target, intermediate)).toMatchObject({
      checkpoint: intermediate,
      trust: { passed: true },
    });
    const newerDelivery = history({
      paths: [settings],
      fromIntermediate: true,
      configured: checkpoint,
      delivered: intermediate,
    });
    expect(await newerDelivery(target, checkpoint)).toMatchObject({
      checkpoint: intermediate,
      trust: { passed: true },
    });
    const untrusted = history({
      paths: [settings, "src/hidden.ts"],
      fromIntermediate: true,
      configured: intermediate,
    });
    const blocked = await untrusted(target, intermediate);
    expect(blocked?.trust.passed).toBe(false);
    expect(blocked?.reason).toContain(target.slice(0, 12));
    expect(blocked?.reason).toContain(intermediate.slice(0, 12));
  });
});
