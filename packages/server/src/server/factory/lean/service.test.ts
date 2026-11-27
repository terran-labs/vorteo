import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createLeanStateStore } from "./state.js";
import { createLeanReconciler } from "./service.js";
import { createMergeGate } from "./merge-gate.js";
import { createMergeIntentStore } from "./merge-intent.js";
import type { IssueLedger } from "./issue-state.js";
import type { Acceptance, GitHubFacts, PullRef, RunnerRef, Verdict } from "./types.js";

it("claims a labeled issue and requests a pinned merge after local review and acceptance", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lean-service-"));
  try {
    const state = createLeanStateStore(home);
    const projectId = "scratch";
    const here = "host/scratch";
    const at = new Date(0).toISOString();
    const facts: GitHubFacts = {
      issues: [
        {
          number: 1,
          title: "One change",
          labels: ["factory:ready"],
          trust: { trusted: true },
          heavy: false,
          priority: false,
          createdAt: at,
          plan: null,
          go: null,
          questions: [],
          sendBacks: [],
        },
      ],
      pulls: [],
      leases: [],
      verdicts: [],
      acceptances: [],
      defaultBranchSha: "base",
      readAt: at,
    };
    const checked: PullRef = { number: 2, headSha: "reviewed", checks: "passing" };
    let verdict: Verdict | undefined;
    let acceptance: Acceptance | undefined;
    const merged: string[] = [];
    const actions: string[] = [];
    const service = createLeanReconciler({
      projectId,
      state,
      now: () => new Date(at),
      facts: async () => facts,
      context: async () => ({
        here,
        now: new Date(at),
        lanesHeld: new Set(["merge", "intake"]),
        config: null,
        capacity: {
          runners: { open: 0, max: 3 },
          heavy: { running: false, waiting: 0, queueLimit: 1 },
          memory: { ok: true, reason: null },
        },
      }),
      async execute(action) {
        actions.push(action.kind === "open-runner" ? action.role : action.kind);
        if (action.kind === "claim") {
          facts.leases.push({
            issue: 1,
            branch: "factory/issue-1",
            installation: here,
            renewedAt: at,
            expiresAt: "2099-01-01",
            seenUnchangedSince: at,
            protocol: 1,
            released: false,
          });
        } else if (action.kind === "open-runner") {
          const role = action.role;
          const runner: RunnerRef = {
            role,
            agentId: role,
            serverId: null,
            account: role,
            accountDefinition: role,
            providerType: "fake",
            openedAt: at,
            attempt: 1,
          };
          await state.mutate(projectId, (ledger: IssueLedger) => {
            ledger.runners[role] = { ...runner, issue: 1, closedAt: null, closeReason: null };
            if (role === "lead")
              facts.issues[0].plan = { files: ["a"], commentId: 1, heavy: false, postedAt: at };
            if (role === "reviewer") {
              verdict = {
                sha: checked.headSha,
                approved: true,
                reviewer: runner,
                findings: null,
                source: "local-runner",
              };
              ledger.localVerdicts = { 1: verdict };
            }
            if (role === "foreman-op") {
              acceptance = {
                sha: checked.headSha,
                outcome: "accepted",
                improvements: [],
                session: role,
                source: "local-session",
                at,
              };
              ledger.acceptances[1] = [acceptance];
            }
          });
        } else if (action.kind === "send-go") {
          facts.issues[0].go = { files: action.files, at };
          facts.pulls.push({
            number: checked.number,
            head: checked.headSha,
            branch: facts.leases[0].branch,
            sameRepo: true,
            files: ["a"],
            checks: "pending",
            reviewEligible: true,
            mergeable: true,
            trustedThreadsOpen: 0,
            labels: [],
          });
        } else throw new Error("Unexpected action " + action.kind);
      },
      mergeGate: createMergeGate({
        here,
        currentMergeEpoch: async () => 1,
        fenceMerge: async (epoch) => epoch === 1,
        ...createMergeIntentStore(state, projectId, async (epoch) => epoch === 1),
        async read() {
          const pull = {
            ...checked,
            branch: facts.leases[0].branch,
            sameRepo: true,
            targetsDefaultBranch: true,
          };
          if (merged.length) return { kind: "merged", pull, mergeSha: "merged" };
          const { runners } = await state.read(projectId);
          return {
            kind: "open",
            pull,
            trust: facts.issues[0].trust,
            blocked: false,
            lease: facts.leases[0],
            ownerOnly: { checkedHeadSha: checked.headSha, touched: [] },
            checksHeadSha: checked.headSha,
            trustedThreadsOpen: 0,
            mergeable: true,
            lead: runners.lead,
            reviewer: runners.reviewer,
            verdict: verdict ?? null,
            acceptance: acceptance ?? null,
            acceptanceSession: runners["foreman-op"],
          };
        },
        async submit(target) {
          expect(target.headSha).toBe(facts.pulls[0].head);
          merged.push(target.headSha);
          return { kind: "submitted" };
        },
        async complete() {
          return { done: true };
        },
      }),
      async recordMerge() {
        facts.issues = [];
      },
    });
    for (let cycle = 0; cycle < 5; cycle++) await service.reconcile();
    expect(actions).toEqual(["claim", "lead", "send-go", "reviewer"]);
    expect(merged).toEqual([]);
    facts.pulls[0].checks = "passing";
    for (let cycle = 0; cycle < 3; cycle++) await service.reconcile();
    expect(actions).toEqual(["claim", "lead", "send-go", "reviewer", "foreman-op"]);
    expect(merged).toEqual(["reviewed"]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
