import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuilderGit, type BuilderGitDependencies } from "./builder-git.js";
import type { ClaimSnapshot } from "./machines/claims.js";
import { createLeanStateStore } from "./state.js";
import { LEAN_PROTOCOL_MAJOR, type LeanLedger } from "./types.js";

vi.mock("@getpaseo/server/factory-project", () => ({
  projectFactoryClaimBranch: (issue: number) => `factory/issue-${issue}`,
}));
vi.mock("../project/claims.js", () => ({ OWNER_ONLY_FILES: [] }));

const branch = "factory/issue-7";
const head = "b".repeat(40);
const installation = "srv_host/project";
const now = new Date("2026-11-27T20:00:00.000Z");
const generation = "e17b7b57-96d4-498e-a548-177619ca73d0";
const caller = "agent-builder";
const params = { issue: 7, expectedHead: head, title: "Update sources", body: "" };
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "factory-builder-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function fixture() {
  const state = createLeanStateStore(home);
  const receipt = {
    issue: 7,
    builderAgentId: caller,
    workspaceId: "workspace",
    planId: "plan",
    branch,
    previousHead: "a".repeat(40),
    head,
    paths: ["approved.ts"],
    preparedAt: now.toISOString(),
    pushedAt: null,
    claimGeneration: generation,
    builderProviderType: "codex",
  };
  const expiresAt = +now / 1000 + 60;
  await state.mutate(
    "project",
    (ledger: LeanLedger & { builderPublications?: Record<string, typeof receipt> }) => {
      ledger.runners[caller] = {
        agentId: caller,
        role: "lead",
        serverId: null,
        account: "local-account",
        accountDefinition: null,
        providerType: "codex",
        openedAt: now.toISOString(),
        attempt: 1,
        issue: 7,
        closedAt: null,
        closeReason: null,
      };
      ledger.leases[7] = {
        issue: 7,
        branch,
        installation,
        renewedAt: now.toISOString(),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        seenUnchangedSince: now.toISOString(),
        protocol: LEAN_PROTOCOL_MAJOR,
        released: false,
      };
      ledger.hostBuilderAssignments = {
        [caller]: {
          issue: 7,
          generation,
          branch,
          workspaceId: "workspace",
          account: "local-account",
          headSha: receipt.previousHead,
        },
      };
      ledger.builderPublications = { receipt };
    },
  );
  const claim: ClaimSnapshot = {
    revision: "initial-revision",
    record: {
      version: 1,
      installation,
      generation,
      nonce: generation,
      expiresAt,
      released: false,
      submission: null,
    },
  };
  const readClaim = vi.fn(async () => structuredClone(claim));
  const pull = {
    number: 12,
    state: "open",
    head: { sha: head, ref: branch, repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
  };
  let created = false;
  const rest = vi.fn<BuilderGitDependencies["github"]["rest"]>(async (method, route) => {
    if (method === "POST" && route.endsWith("/pulls")) {
      created = true;
      return { status: 201, body: pull };
    }
    if (route.includes("/pulls?")) return { status: 200, body: created ? [pull] : [] };
    return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: head } } };
  });
  const deps: BuilderGitDependencies = {
    projectId: "project",
    installation,
    repository: "owner/repo",
    privateRoot: home,
    state,
    now: () => now,
    github: { rest },
    readAuthority: async () => ({
      workspaceId: "workspace",
      planId: "plan",
      approvedPaths: ["approved.ts"],
      protectedPaths: [],
      baseBranch: "main",
    }),
    allowWrites: async () => true,
    machineClaims: { readClaim },
  };
  return { deps, claim, rest };
}

describe("Builder publication with machine claims", () => {
  it("recovers the exact saved publication, opens one pull request after renewal and leaves signing to the Host observer", async () => {
    const { deps, claim, rest } = await fixture();
    const git = createBuilderGit(deps);
    expect(await git.publishedHead(caller, 7)).toMatchObject({
      head,
      pushedAt: now.toISOString(),
      claimGeneration: generation,
    });
    claim.revision = "renewed-revision";

    expect(await git.openPullRequest(caller, params)).toMatchObject({ head, number: 12 });
    expect(await git.openPullRequest(caller, params)).toMatchObject({ head, number: 12 });
    expect(claim.record.submission).toBeNull();
    expect(rest.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });

  it("blocks publication after release and blocks a new generation for the same Builder after reload", async () => {
    const { deps, claim, rest } = await fixture();
    await createBuilderGit(deps).publishedHead(caller, 7);
    const get = rest.getMockImplementation()!;
    rest.mockImplementation(async (...args) => {
      const response = await get(...args);
      if (args[1].includes("/pulls?")) claim.record.released = true;
      return response;
    });
    await expect(createBuilderGit(deps).openPullRequest(caller, params)).rejects.toThrow(
      "no longer holds",
    );
    claim.record.released = false;
    claim.record.generation = "2b3caf8d-1049-4dbd-bcae-723b3441101c";
    const restarted = createBuilderGit({ ...deps, state: createLeanStateStore(home) });
    await expect(restarted.openPullRequest(caller, params)).rejects.toThrow("no matching launch");
    expect(claim.record.submission).toBeNull();
    expect(rest.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("refuses a receipt from an earlier generation even if the Builder first binds after takeover", async () => {
    const { deps, claim, rest } = await fixture();
    claim.record.generation = "2b3caf8d-1049-4dbd-bcae-723b3441101c";
    await expect(createBuilderGit(deps).openPullRequest(caller, params)).rejects.toThrow(
      "no matching launch",
    );
    expect(claim.record.submission).toBeNull();
    expect(rest.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
});
