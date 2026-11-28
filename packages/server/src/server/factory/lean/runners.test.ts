import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAccountTable } from "./accounts.js";
import { createRunnerPort, type RunnerRecord } from "./runners.js";
import { createLeanStateStore } from "./state.js";
import type { ForeignReviewOpenEvidence } from "./review-evidence.js";

const projectId = "project";
const installation = "primary/project";
const now = new Date("2026-11-27T20:00:00Z");

const binding: ForeignReviewOpenEvidence = {
  policy: { providerType: "codex", configCommit: "a".repeat(40) },
  submission: {
    installation: "secondary/project",
    generation: "7bdf4309-0c14-4791-9b34-6a31dd017a4e",
    head: "b".repeat(40),
    builderProviderType: "codex",
  },
};

function accountsFor(state: ReturnType<typeof createLeanStateStore>, alternate?: string) {
  return createAccountTable({
    projectId,
    state,
    now: () => now,
    roleAccounts: async () => ({
      providerType: "codex",
      profileId: null,
      allowedDefinitions: null,
    }),
    accountDefinitions: async () =>
      new Map([
        ["codex-primary", "codex-definition"],
        ["claude-primary", "claude-definition"],
        ["codex-alternate", "alternate-definition"],
      ]),
    accounts: {
      readyProviders: async () =>
        alternate
          ? ["codex-primary", "claude-primary", alternate]
          : ["codex-primary", "claude-primary"],
      providerType: ({ provider }) => (provider?.startsWith("claude") ? "claude" : "codex"),
      profileAccount: () => null,
      readUsage: async () => ({ providers: [], fetchedAt: now.toISOString() }),
      defaultProvider: async () => "claude-primary",
      destinationAccounts: async () => new Map(),
    },
    accountPolicy: async ({ candidates }) => ({
      considered: candidates.map((provider) => ({
        provider,
        verdict: "qualifies",
        remainingPct: 80,
      })),
    }),
  });
}

it("opens the pinned Reviewer without a Builder record and persists the verified launch binding", async () => {
  const temp = await mkdtemp(join(tmpdir(), "factory-review-"));
  try {
    const state = createLeanStateStore(temp);
    const accounts = accountsFor(state);
    const port = createRunnerPort({
      projectId,
      installation,
      state,
      accounts,
      now: () => now,
      place: async () => ({ serverId: null }),
      async createAgent({ choice, identity }) {
        expect(choice.account).toBe("codex-primary");
        if (!identity) throw new Error("Missing durable runner identity.");
        const review = {
          headSha: binding.submission.head,
          daemonCreated: true,
          clean: true,
          nonChild: true,
          freshSession: true,
        } as const;
        await identity.seal("workspace", review);
        return { agentId: identity.agentId, review };
      },
      discoverAgent: async () => "missing",
      subscribe: async () => () => {},
      prompt: async () => {},
      lastReply: async () => null,
      archiveAgent: async () => {},
      checkLeadBranch: async () => null,
    });
    const input = {
      projectId,
      issue: 7,
      role: "reviewer" as const,
      brief: "Review the signed head.",
      foreignReview: binding,
    };
    const result = await port.open(input);
    expect(result).toMatchObject({ installation, providerType: "codex" });
    const ledger = await state.read(projectId);
    const records: RunnerRecord[] = Object.values(ledger.runners);
    expect(records).toHaveLength(1);
    expect(records[0].reviewAccountSelection).toBeUndefined();
    expect(records[0].foreignReviewLaunch).toMatchObject({
      claimGeneration: binding.submission.generation,
      headSha: binding.submission.head,
      candidates: [
        { accountDefinition: "codex-definition", reason: "selected" },
        { accountDefinition: "claude-definition", reason: "wrong-provider" },
      ],
    });
    expect(await port.open(input)).toEqual(result);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("parks same-provider foreign review when an eligible alternative has no recorded exclusion", async () => {
  const temp = await mkdtemp(join(tmpdir(), "factory-review-"));
  try {
    const accounts = accountsFor(createLeanStateStore(temp), "codex-alternate");
    const input = { serverId: null, avoid: [] };
    expect(await accounts.chooseForeignReviewer(input, binding)).toEqual({
      parked: { providerType: "codex", resetsAt: null },
    });
    const unknownProvider = {
      ...binding,
      submission: { ...binding.submission, builderProviderType: undefined },
    };
    expect(await accounts.chooseForeignReviewer(input, unknownProvider)).toEqual({
      parked: { providerType: "codex", resetsAt: null },
    });
    const differentProvider = {
      ...binding,
      submission: { ...binding.submission, builderProviderType: "claude" },
    };
    expect(await accounts.chooseForeignReviewer(input, differentProvider)).toMatchObject({
      providerType: "codex",
      account: "codex-primary",
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
