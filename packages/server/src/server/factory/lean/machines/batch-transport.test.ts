import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryGitHub } from "../../project/claims.js";
import { createLeanStateStore } from "../state.js";
import {
  createMachineBatchTransport,
  type MachineBatchTransportOptions,
} from "./batch-transport.js";
import { createMachineBatchRuntime } from "./batch-runtime.js";
import { createGitClaimStore } from "./claim-git.js";
import { readPinnedFactoryConfig } from "./pinned-factory-config.js";
import type { HeavyGateBatch } from "./signed-gates.js";

const repository = "owner/repo";
const primary = "host_a/project";
const secondary = "host_b/project";
const target = {
  repository,
  primary,
  issue: 7,
  head: "a".repeat(40),
  configCommit: "b".repeat(40),
};
const batch: HeavyGateBatch = {
  batchId: "heavy-1",
  target,
  machine: secondary,
  commands: [{ argv: ["npm", "test"], where: "container" }],
};

function configFixture(primaryKey: string, secondaryKey: string, includeBatch = true) {
  const config = {
    schema: "vorteo-factory",
    version: 1,
    mode: "lean",
    order: [primary],
    machines: {
      [primary]: { publicKey: primaryKey },
      [secondary]: { publicKey: secondaryKey },
    },
    issueGates: [{ argv: ["npm", "run", "cheap"], where: "container" }],
    ...(includeBatch && {
      heavyGateBatches: { [batch.batchId]: { machine: secondary, commands: batch.commands } },
    }),
  };
  const content = Buffer.from(JSON.stringify(config));
  const root = "c".repeat(40);
  const directory = "d".repeat(40);
  const blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  const replies = new Map<string, unknown>([
    [`commits/${target.configCommit}`, { sha: target.configCommit, tree: { sha: root } }],
    [
      `trees/${root}`,
      {
        sha: root,
        truncated: false,
        tree: [{ path: ".github", mode: "040000", type: "tree", sha: directory }],
      },
    ],
    [
      `trees/${directory}`,
      {
        sha: directory,
        truncated: false,
        tree: [{ path: "vorteo-factory.json", mode: "100644", type: "blob", sha: blob }],
      },
    ],
    [`blobs/${blob}`, { sha: blob, encoding: "base64", content: content.toString("base64") }],
  ]);
  const github: FactoryGitHub = {
    async rest(_method, route) {
      const value = replies.get(route.replace(`repos/${repository}/git/`, ""));
      return value === undefined ? { status: 404, body: null } : { status: 200, body: value };
    },
  };
  return { config, github, replies, directory, blob };
}

describe("GitHub machine batch transport", () => {
  let home: string;
  beforeEach(async () => {
    vi.stubEnv("PASEO_NETWORK_MODE", undefined);
    home = await mkdtemp(join(await realpath(tmpdir()), "vorteo-batch-transport-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function fixture(includeBatch = true) {
    let clock = Date.parse("2026-11-27T20:00:00Z");
    let head = target.head;
    const primaryKeys = generateKeyPairSync("ed25519");
    const secondaryKeys = generateKeyPairSync("ed25519");
    const keyPath = join(home, "primary.pem");
    const secondaryPath = join(home, "secondary.pem");
    await Promise.all([
      writeFile(keyPath, primaryKeys.privateKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
      }),
      writeFile(secondaryPath, secondaryKeys.privateKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
      }),
    ]);
    const { github } = configFixture(
      primaryKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      secondaryKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      includeBatch,
    );
    const remote = join(home, "remote.git");
    const cwd = join(home, "local.git");
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    execFileSync("git", ["init", "--quiet", "--bare", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", remote]);
    const chargePrimary = vi.fn(async () => {});
    const chargeSecondary = vi.fn(async () => {});
    const git = { cwd, localRemote: remote, chargeMutation: chargePrimary };
    const execute = vi.fn<MachineBatchTransportOptions["execute"]>(
      async (challenge, command, authorize) => {
        if (!(await authorize())) return null;
        const startedAt = new Date(clock++).toISOString();
        return {
          head: challenge.target.head,
          machine: challenge.machine,
          where: command.where,
          tree: "e".repeat(40),
          exitCode: 0,
          outputMatched: true,
          startedAt,
          finishedAt: new Date(clock).toISOString(),
        };
      },
    );
    const common: Omit<MachineBatchTransportOptions, "keyPath" | "projectId" | "here" | "state"> = {
      github,
      git,
      repository,
      now: () => clock,
      environment: "host",
      readInputs: async () => ({
        ...target,
        head,
        trusted: true,
        protectedPaths: [],
        hostedChecks: "passing",
      }),
      authorizeBatch: async () => true,
      execute,
    };
    const primaryHost = () =>
      createMachineBatchTransport({
        ...common,
        state: createLeanStateStore(home),
        here: primary,
        projectId: "primary",
        keyPath,
      });
    const secondaryHost = () =>
      createMachineBatchTransport({
        ...common,
        git: { ...git, chargeMutation: chargeSecondary },
        state: createLeanStateStore(home),
        here: secondary,
        projectId: "secondary",
        keyPath: secondaryPath,
      });
    return {
      runtime: (runtimeKeyPath = keyPath) =>
        createMachineBatchRuntime({
          ...common,
          now: () => new Date(clock),
          state: createLeanStateStore(home),
          projectId: "primary",
          paseoHome: home,
          here: primary,
          primary,
          keyPath: runtimeKeyPath,
          isActive: async () => true,
          lifetimeMs: 60_000,
        }),
      primaryHost: await primaryHost(),
      secondaryHost: await secondaryHost(),
      restartPrimary: primaryHost,
      restartSecondary: secondaryHost,
      refs: createGitClaimStore({ ...git, repository, namespace: "gate-batches" }),
      claimRefs: createGitClaimStore({ ...git, repository }),
      remote,
      execute,
      chargePrimary,
      chargeSecondary,
      setHead: (next: string) => {
        head = next;
      },
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("publishes and consumes authenticated evidence exactly once without creating a PR or claim ref", async () => {
    const f = await fixture();
    const [request, duplicate] = await Promise.all([
      f.primaryHost.requestConfigured(7, target.head, batch.batchId, 60_000),
      f.primaryHost.request(batch, 60_000),
    ]);
    expect(request).toBeTruthy();
    expect(duplicate).toEqual(request);
    expect(await f.secondaryHost.respond(7)).toBe(true);
    expect(await f.claimRefs.read(7)).toBeNull();
    expect(
      execFileSync("git", ["-C", f.remote, "for-each-ref", "--format=%(refname)"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("refs/vorteo/gate-batches/7");
    const record = vi.fn();
    expect(await f.primaryHost.acceptConfigured(7, target.head, batch.batchId, record)).toBe(true);
    expect(record).toHaveBeenCalledWith(expect.any(Object), [
      expect.objectContaining({ head: target.head, machine: secondary, exitCode: 0 }),
    ]);
    expect(await (await f.restartPrimary()).accept(batch, record)).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(f.chargePrimary).toHaveBeenCalledTimes(1);
    expect(f.chargeSecondary).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("uses durable accepted evidence without publishing another challenge after restart and expiry", async () => {
    const f = await fixture();
    expect(await f.runtime().readyForAcceptance(7, target.head)).toBe(false);
    expect(await f.secondaryHost.respond(7)).toBe(true);
    expect(await f.runtime().readyForAcceptance(7, target.head)).toBe(true);
    f.advance(60_000);
    expect(await f.runtime().readyForAcceptance(7, target.head)).toBe(true);
    expect(f.chargePrimary).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("allows ordinary gate acceptance without opening a transport when no batch is configured", async () => {
    const f = await fixture(false);
    expect(await f.runtime(join(home, "missing.pem")).readyForAcceptance(7, target.head)).toBe(
      true,
    );
    expect(f.chargePrimary).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects a tampered challenge and retries a budget-denied response without executing twice", async () => {
    const f = await fixture();
    await f.primaryHost.request(batch, 60_000);
    const original = await f.refs.read(7);
    if (!original) throw new Error("Missing request.");
    await f.refs.compareAndSwap(7, original.revision, original.body.replace("heavy-1", "heavy-2"));
    expect(await f.secondaryHost.respond(7)).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();

    const altered = await f.refs.read(7);
    if (!altered) throw new Error("Missing altered request.");
    await f.refs.compareAndSwap(7, altered.revision, original.body);
    f.chargeSecondary.mockRejectedValueOnce(new Error("mutation budget exhausted"));
    await expect(f.secondaryHost.respond(7)).rejects.toThrow("mutation budget exhausted");
    expect(await (await f.restartSecondary()).respond(7)).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.primaryHost.accept(batch)).toBe(true);
  }, 20_000);

  it("rejects expired challenges and a response for a moved PR head", async () => {
    const f = await fixture();
    expect(
      await f.primaryHost.request(
        { ...batch, commands: [{ argv: ["npm", "run", "cheap"], where: "container" }] },
        1000,
      ),
    ).toBeNull();
    await f.primaryHost.request(batch, 1_000);
    f.advance(1_000);
    expect(await f.secondaryHost.respond(7)).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
    await f.primaryHost.request(batch, 60_000);
    expect(await f.secondaryHost.respond(7)).toBe(true);
    const previous = await f.refs.read(7);
    if (!previous) throw new Error("Missing previous response.");
    const newHead = "f".repeat(40);
    f.setHead(newHead);
    expect(await f.primaryHost.accept(batch)).toBe(false);
    expect(await f.primaryHost.requestConfigured(7, newHead, batch.batchId, 60_000)).toBeTruthy();
    const latest = await f.refs.read(7);
    if (!latest) throw new Error("Missing newest challenge.");
    await f.refs.compareAndSwap(7, latest.revision, previous.body);
    f.setHead(target.head);
    expect(await (await f.restartPrimary()).accept(batch)).toBe(false);
  }, 20_000);

  it("retries a pre-launch refusal but preserves a reservation after possible execution", async () => {
    const f = await fixture();
    await f.primaryHost.request(batch, 60_000);
    f.execute.mockResolvedValueOnce(null);
    expect(await f.secondaryHost.respond(7)).toBe(false);
    f.execute.mockImplementationOnce(async (_challenge, _command, authorize) => {
      expect(await authorize()).toBe(true);
      return null;
    });
    expect(await (await f.restartSecondary()).respond(7)).toBe(false);
    await expect((await f.restartSecondary()).respond(7)).rejects.toThrow(
      "may already have started",
    );
    expect(f.execute).toHaveBeenCalledTimes(2);
  }, 20_000);
});

it("reads the exact Git blob and refuses symlink or substituted configuration", async () => {
  const { github, config, directory, blob, replies } = configFixture(
    "primary-pem",
    "secondary-pem",
  );
  expect(await readPinnedFactoryConfig(github, repository, target.configCommit)).toEqual(config);
  replies.set(`blobs/${blob}`, {
    sha: blob,
    encoding: "base64",
    content: Buffer.from("{}").toString("base64"),
  });
  await expect(readPinnedFactoryConfig(github, repository, target.configCommit)).rejects.toThrow(
    "wrong Factory config bytes",
  );
  replies.set(`trees/${directory}`, {
    sha: directory,
    truncated: false,
    tree: [{ path: "vorteo-factory.json", mode: "120000", type: "blob", sha: blob }],
  });
  await expect(readPinnedFactoryConfig(github, repository, target.configCommit)).rejects.toThrow(
    "regular file",
  );
});
