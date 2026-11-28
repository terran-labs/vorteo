import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLeanStateStore } from "../state.js";
import { finishPausedMachineBuilder } from "../runtime.js";
import type { LeanLedger, RunnerRef } from "../types.js";
import { createGitClaimStore } from "./claim-git.js";
import {
  createMachineLeasePort,
  createUnsignedHostLeasePort,
  type UnsignedHostClaimOptions,
} from "./claims.js";
import { signMachinePayload, verifyMachinePayload } from "./host-key.js";
import { createPausedMachineCleanup } from "./paused-cleanup.js";
import { resolveMachineRoles } from "./roles.js";
import { verifyHostBuilderWorktreeCustody } from "./host-worktree-custody.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "paused-claim-release-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const here = "fixture/local";
const repository = "owner/offline";
const head = "a".repeat(40);
const moved = "b".repeat(40);
const issue = 12;
const now = () => new Date("2026-11-27T23:00:00Z");
function git(args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: root,
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid",
    },
  }).trim();
}

async function fixture(savedHead = head, unsigned = false) {
  const localRemote = join(root, "fixture.git");
  const cwd = join(root, "claims.git");
  // Only two private fixture repositories; no workspace or network I/O.
  git(["init", "--bare", "--quiet", localRemote]);
  git(["init", "--bare", "--quiet", cwd]);
  git(["--git-dir", cwd, "remote", "add", "origin", localRemote]);
  const keys = unsigned ? null : generateKeyPairSync("ed25519");
  const pem = keys?.publicKey.export({ type: "spki", format: "pem" }).toString();
  const config = {
    version: 1,
    mode: "lean",
    order: [here],
    ...(pem ? { machines: { [here]: { publicKey: pem } } } : {}),
  };
  const roles = resolveMachineRoles(config, here).roles!;
  const replacement =
    keys &&
    generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const replacementRoles =
    replacement &&
    resolveMachineRoles(
      {
        ...config,
        machines: { [here]: { publicKey: replacement } },
      },
      here,
    ).roles!;
  const controls = {
    paused: true,
    independent: true,
    enrolled: true,
    rotated: false,
    charge: 0,
    beforePush: () => {},
    read: 0,
    moveOnRead: Infinity,
  };
  const readWorkHead = async () => (++controls.read >= controls.moveOnRead ? moved : savedHead);
  const sign = async (payload: Uint8Array) => {
    if (!keys) throw new Error("Host dispatch must not sign.");
    return signMachinePayload(keys.privateKey, payload);
  };
  const store = createGitClaimStore({
    cwd,
    repository,
    localRemote,
    chargeMutation: async () => {},
  });
  const core: UnsignedHostClaimOptions = {
    repository,
    installation: here,
    refs: store,
    now,
    readWorkHead,
    prepare: async () => ({ brief: "fixture", checkedHeadSha: null }),
    ensureWorkBranch: async () => {},
    pushSavedWork: async () => {
      throw new Error("No workspace writes.");
    },
    isPrimary: () => true,
  };
  const port = (options: UnsignedHostClaimOptions) =>
    unsigned
      ? createUnsignedHostLeasePort(options)
      : createMachineLeasePort({
          ...options,
          sign,
          verify: (holder, payload, signature) =>
            Boolean(pem && holder === here && verifyMachinePayload(pem, payload, signature)),
        });
  const claims = port(core);
  // A missing claim must start without an existing work head.
  const install = port({
    ...core,
    readWorkHead: async () => (published ? savedHead : null),
    ensureWorkBranch: async () => {
      published = true;
    },
  });
  let published = false;
  const acquired = await install.acquire(issue);
  if (acquired.outcome !== "claimed") throw new Error("Fixture claim unavailable");
  const snapshot = (await claims.readClaim(issue))!;
  const state = createLeanStateStore(root);
  await state.mutate("local", (ledger) => {
    ledger.leases[issue] = acquired.lease;
  });
  controls.read = 0;
  const cleanup = createPausedMachineCleanup({
    projectId: "local",
    issue,
    installation: here,
    primary: here,
    state,
    git: { cwd, repository, localRemote },
    now,
    readWorkHead,
    isOwnerPaused: async () => controls.paused,
    canVerifySavedWork: async () => controls.independent,
    ...(unsigned
      ? {
          mode: "unsigned-host" as const,
          refreshPinnedRoles: async () => ({ here, primary: here }),
        }
      : {
          sign,
          async refreshPinnedRoles() {
            if (!controls.enrolled) return null;
            return controls.rotated ? replacementRoles || null : roles;
          },
        }),
    chargeMutation: async () => {
      controls.charge++;
      controls.beforePush();
    },
  });
  const input = {
    issue,
    claimRevision: snapshot.revision,
    claimGeneration: snapshot.record.generation,
    savedHead,
  };
  const outcome = async () =>
    (
      (await state.read("local")) as LeanLedger & {
        pausedMachineCleanups?: Record<number, { result: unknown }>;
      }
    ).pausedMachineCleanups?.[issue]?.result;
  return { claims, cleanup, controls, input, state, outcome };
}

it("rejects release and recording for a different issue without charging", async () => {
  const { cleanup, controls, input, outcome } = await fixture();
  await expect(cleanup.release({ ...input, issue: issue + 1 })).rejects.toThrow(
    "different Factory issue",
  );
  await expect(
    cleanup.record({
      issue: issue + 1,
      claimGeneration: null,
      result: { kind: "blocked", reason: "fixture" },
    }),
  ).rejects.toThrow("different Factory issue");
  expect(controls.charge).toBe(0);
  expect(await outcome()).toBeUndefined();
});

it.each(["saved", "dirty", "unproven"] as const)(
  "checks the paused lifecycle for %s native Host work",
  async (kind) => {
    const worktree = join(root, "native-fixture");
    git(["init", "--quiet", worktree]);
    const readme = join(worktree, "README.md");
    await writeFile(readme, "saved\n");
    git(["-C", worktree, "add", "README.md"]);
    git(["-C", worktree, "commit", "--quiet", "-m", "Saved fixture"]);
    const savedHead = git(["-C", worktree, "rev-parse", "HEAD^{commit}"]);
    const { cleanup, controls, claims, outcome, state } = await fixture(savedHead, true);
    if (kind === "dirty") await writeFile(readme, "unsaved\n");
    controls.independent = kind !== "unproven";
    const runner: RunnerRef = {
      agentId: "builder",
      role: "lead",
      serverId: null,
      account: "local",
      accountDefinition: "fixture",
      providerType: "codex",
      openedAt: now().toISOString(),
      attempt: 1,
    };
    await state.mutate("local", (ledger) => {
      ledger.runners[runner.agentId] = { ...runner, issue, closedAt: null, closeReason: null };
    });
    const inspections: Array<true | undefined> = [];
    let quiesced = false;
    let archivedAgent = false;
    await finishPausedMachineBuilder({
      issue,
      here,
      now,
      cleanup,
      readClaim: () => claims.readClaim(issue),
      localBuilder: async () => runner,
      async quiesce() {
        quiesced = true;
      },
      async savedHead(_runner, _generation, archived) {
        expect(quiesced).toBe(true);
        expect(Boolean(archived)).toBe(archivedAgent);
        inspections.push(archived);
        if (git(["-C", worktree, "status", "--porcelain=v1"])) throw new Error("Fixture is dirty.");
        return git(["-C", worktree, "rev-parse", "HEAD^{commit}"]);
      },
      async archive() {
        archivedAgent = true;
      },
    });
    expect(inspections).toEqual(
      { saved: [undefined, true], dirty: [undefined], unproven: [] }[kind],
    );
    expect(archivedAgent).toBe(kind === "saved");
    expect((await claims.readClaim(issue))?.record.released).toBe(kind === "saved");
    expect((await state.read("local")).runners[runner.agentId].closedAt !== null).toBe(
      kind === "saved",
    );
    expect(await outcome()).toMatchObject({ kind: kind === "saved" ? "released" : "blocked" });
  },
);

it("releases the exact independently saved claim once and records the signed result", async () => {
  const { claims, cleanup, controls, input, state, outcome } = await fixture();
  await expect(
    cleanup.record({
      issue,
      claimGeneration: input.claimGeneration,
      result: { kind: "released", savedHead: head },
    }),
  ).rejects.toThrow("no verified");
  await cleanup.release(input);
  const released = (await claims.readClaim(issue))!;
  expect(released.revision).not.toEqual(input.claimRevision);
  expect(released.record).toMatchObject({
    generation: input.claimGeneration,
    released: true,
    submission: null,
  });
  await cleanup.record({
    issue,
    claimGeneration: input.claimGeneration,
    result: { kind: "released", savedHead: head },
  });
  expect(await outcome()).toEqual({ kind: "released", savedHead: head });
  expect((await state.read("local")).leases[issue].released).toBe(true);
  await expect(cleanup.release(input)).rejects.toThrow("changed or expired");
  expect(controls.charge).toBe(1);
});

it("records unsupported workspace custody without charging or touching the live claim", async () => {
  const { cleanup, controls, outcome, claims } = await fixture();
  controls.independent = false;
  await expect(cleanup.assertPaused()).rejects.toThrow("No trusted saved-work check");
  await cleanup.record({
    issue,
    claimGeneration: null,
    result: { kind: "blocked", reason: "generic fallback" },
  });
  expect(await outcome()).toMatchObject({
    kind: "blocked",
    reason: expect.stringContaining("worktree and claim were kept"),
  });
  expect((await claims.readClaim(issue))?.record.released).toBe(false);
  expect(controls.charge).toBe(0);
});

it("refuses a changed generation and rechecks owner pause after charging before any push", async () => {
  const { cleanup, controls, input, claims } = await fixture();
  await expect(
    cleanup.release({ ...input, claimGeneration: "d65a7efb-d3a8-476d-9fdf-367993d7c87f" }),
  ).rejects.toThrow("changed or expired");
  expect(controls.charge).toBe(0);
  controls.beforePush = () => {
    controls.paused = false;
  };
  await expect(cleanup.release(input)).rejects.toThrow("no longer paused");
  expect((await claims.readClaim(issue))?.record.released).toBe(false);
});

it("records an uncertain release if the remote head moves after the signed CAS", async () => {
  const { cleanup, controls, input, claims, state, outcome } = await fixture();
  controls.moveOnRead = 3;
  await expect(cleanup.release(input)).rejects.toThrow("may have landed");
  expect((await claims.readClaim(issue))?.record.released).toBe(true);
  await cleanup.record({
    issue,
    claimGeneration: input.claimGeneration,
    result: { kind: "blocked", reason: "generic fallback" },
  });
  expect(await outcome()).toMatchObject({
    kind: "blocked",
    reason: expect.stringContaining("may have landed"),
  });
  expect((await state.read("local")).leases[issue].released).toBe(false);
});

it("verifies the candidate against the owner keys again after charging", async () => {
  const { cleanup, controls, input, claims } = await fixture();
  controls.beforePush = () => {
    controls.rotated = true;
  };
  await expect(cleanup.release(input)).rejects.toThrow("signing key is no longer enrolled");
  expect((await claims.readClaim(issue))?.revision).toBe(input.claimRevision);
  expect(controls.charge).toBe(1);
});

it("accepts the exact assigned Host linked worktree and fences overlapping or missing inventory", async () => {
  const projectId = "local";
  const key = `builder-${issue}`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const pool = join(root, "factory", "lean", "runner-workspaces", hash(projectId));
  await mkdir(pool, { recursive: true, mode: 0o700 });
  const mainRepoRoot = join(pool, "repository.git");
  const cwd = join(pool, key);
  const seed = join(root, "seed");
  git(["init", "--quiet", seed]);
  git(["-C", seed, "commit", "--allow-empty", "--quiet", "-m", "Fixture"]);
  git(["init", "--bare", "--quiet", mainRepoRoot]);
  const branch = `factory/issue-${issue}`;
  git(["--git-dir", mainRepoRoot, "fetch", "--quiet", seed, `HEAD:refs/heads/${branch}`]);
  git(["--git-dir", mainRepoRoot, "worktree", "add", "--quiet", cwd, branch]);
  const workspaceId = `wks_${hash(`${projectId}/${key}`).slice(0, 16)}`;
  const input: Parameters<typeof verifyHostBuilderWorktreeCustody>[0] = {
    host: { paseoHome: root, topology: "host-only", guestRoots: [] },
    projectId,
    installation: here,
    issue,
    runner: {
      agentId: "assigned",
      installation: here,
      issue,
      role: "lead",
      serverId: null,
      account: "account",
    },
    session: { agentId: "assigned", workspaceId, provider: "account" },
    workspace: {
      workspaceId,
      projectId,
      kind: "worktree",
      branch,
      cwd,
      worktreeRoot: cwd,
      mainRepoRoot,
      archivedAt: null,
    },
  };
  expect(await verifyHostBuilderWorktreeCustody(input)).toBe(true);
  const guestRoots = join(cwd, "shared");
  await mkdir(guestRoots);
  expect(
    await verifyHostBuilderWorktreeCustody({
      ...input,
      host: { ...input.host, topology: "paired", guestRoots: [guestRoots] },
    }),
  ).toBe(false);
  expect(
    await verifyHostBuilderWorktreeCustody({
      ...input,
      host: { ...input.host, topology: "paired", guestRoots: null },
    }),
  ).toBe(false);
  expect(
    await verifyHostBuilderWorktreeCustody({
      ...input,
      host: { ...input.host, topology: "paired", guestRoots: [seed] },
    }),
  ).toBe(true);
  expect(
    await verifyHostBuilderWorktreeCustody({
      ...input,
      session: { ...input.session, agentId: "unassigned" },
    }),
  ).toBe(false);
});
