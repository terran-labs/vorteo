import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createGitClaimStore } from "./claim-git.js";
import { createClosedClaimCleanup } from "./claim-cleanup.js";
import {
  CLAIM_TTL_MS,
  createMachineLeasePort,
  createUnsignedHostLeasePort,
  type ClaimRefStore,
} from "./claims.js";

const base = "a".repeat(40);
const work = "b".repeat(40);
const provider = "codex";

function fixture(enrolled = true) {
  let now = Date.parse("2026-11-27T12:00:00Z");
  let head: string | null = null;
  const bodies = new Map<number, { revision: string; body: string }>();
  const keys = {
    host_a: generateKeyPairSync("ed25519"),
    host_b: generateKeyPairSync("ed25519"),
  };
  let writes = 0;
  const refs: ClaimRefStore = {
    async read(issue) {
      return bodies.get(issue) ?? null;
    },
    async compareAndSwap(issue, expected, body) {
      if ((bodies.get(issue)?.revision ?? null) !== expected) return false;
      if (body === null) bodies.delete(issue);
      else bodies.set(issue, { revision: String(++writes), body });
      return true;
    },
  };
  const pushSavedWork = vi.fn(async () => {
    head = work;
    return work;
  });
  const ensureWorkBranch = vi.fn(async () => {
    head ??= base;
  });
  function port(installation: keyof typeof keys) {
    return createMachineLeasePort({
      repository: "owner/repo",
      installation,
      refs,
      now: () => new Date(now),
      sign: (bytes) => sign(null, bytes, keys[installation].privateKey).toString("base64"),
      verify: (holder, bytes, signature) => {
        const key = keys[holder as keyof typeof keys]?.publicKey;
        return Boolean(
          enrolled && key && verify(null, bytes, key, Buffer.from(signature, "base64")),
        );
      },
      prepare: async () => ({ brief: "Issue brief", checkedHeadSha: null }),
      readWorkHead: async () => head,
      ensureWorkBranch,
      pushSavedWork,
      isPrimary: () => installation === "host_a",
    });
  }
  return {
    a: port("host_a"),
    b: port("host_b"),
    bodies,
    ensureWorkBranch,
    pushSavedWork,
    advance: (ms: number) => {
      now += ms;
    },
    setHead: (sha: string) => {
      head = sha;
    },
  };
}

describe("machine leases", () => {
  it("leaves the issue available when the local signing key is not enrolled", async () => {
    const f = fixture(false);
    await expect(f.a.acquire(3)).rejects.toThrow("not enrolled");
    expect(f.bodies.size).toBe(0);
    expect(f.ensureWorkBranch).not.toHaveBeenCalled();
  });
  it("allows one acquisition and recovers a claim whose work branch creation failed", async () => {
    const f = fixture();
    f.ensureWorkBranch.mockRejectedValueOnce(new Error("branch creation unavailable"));
    const attempts = await Promise.allSettled([f.a.acquire(3), f.b.acquire(3)]);
    expect(attempts).toContainEqual(expect.objectContaining({ status: "rejected" }));
    expect(attempts).toContainEqual(
      expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({ outcome: "foreign" }),
      }),
    );
    const record = await f.a.readClaim(3);
    const owner = record?.record.installation === "host_a" ? f.a : f.b;
    expect(await owner.acquire(3)).toMatchObject({ outcome: "held" });
  });

  it("checks the lease again after recovering a missing work branch", async () => {
    const f = fixture();
    f.ensureWorkBranch.mockRejectedValueOnce(new Error("branch creation unavailable"));
    await expect(f.a.acquire(3)).rejects.toThrow("branch creation unavailable");
    f.ensureWorkBranch.mockImplementationOnce(async () => {
      f.advance(CLAIM_TTL_MS);
      f.setHead(base);
    });
    await expect(f.a.acquire(3)).rejects.toThrow("could not confirm the claim");
  });

  it("refuses an existing unsigned work branch and rejects replay on another issue", async () => {
    const f = fixture();
    await f.a.acquire(3);
    f.bodies.set(4, f.bodies.get(3)!);
    await expect(f.b.readClaim(4)).rejects.toThrow("signature is invalid");
    expect(await f.b.acquire(5)).toMatchObject({
      outcome: "refused",
      code: "unsigned-work-branch",
    });
  });

  it("waits for the work head to settle on the reader clock, then takes over in place", async () => {
    const f = fixture();
    await f.a.acquire(3);
    const before = (await f.a.readClaim(3))!;
    await f.b.readClaim(3);
    f.advance(CLAIM_TTL_MS - 1000);
    f.setHead(work);
    await f.b.readClaim(3);
    f.advance(1000);
    expect(await f.b.acquire(3)).toMatchObject({ outcome: "foreign" });
    f.advance(CLAIM_TTL_MS - 1000);
    expect(await f.b.acquire(3)).toMatchObject({
      outcome: "claimed",
      continueFrom: "factory/issue-3",
      lease: { installation: "host_b" },
    });
    await expect(f.a.registerSubmission(3, before.revision, work, provider)).rejects.toThrow(
      "no longer holds",
    );
    expect(await f.b.readSubmission(3, work)).toBeNull();
  });

  it("holds the claim through a failed save and releases only after the expected push", async () => {
    const f = fixture();
    await f.a.acquire(3);
    const before = (await f.a.readClaim(3))!;
    f.pushSavedWork.mockRejectedValueOnce(new Error("push failed"));
    await expect(f.a.release(3, "pause")).rejects.toThrow("push failed");
    expect(await f.a.readClaim(3)).toEqual(before);
    f.pushSavedWork.mockResolvedValueOnce(work);
    await expect(f.a.release(3, "pause")).rejects.toThrow("could not confirm the saved work head");
    expect(await f.a.readClaim(3)).toEqual(before);
    await f.a.release(3, "pause");
    expect(f.pushSavedWork).toHaveBeenLastCalledWith(3, {
      claimRevision: before.revision,
      workHead: base,
    });
    expect(await f.b.acquire(3)).toMatchObject({
      outcome: "claimed",
      continueFrom: "factory/issue-3",
    });
  });

  it("authenticates the pinned submission provider and quarantines later pushes", async () => {
    const f = fixture();
    await f.a.acquire(3);
    const before = (await f.a.readClaim(3))!;
    f.setHead(work);
    await f.a.registerSubmission(3, before.revision, work, provider);
    expect(await f.b.readSubmission(3, work)).toMatchObject({
      record: { submission: { head: work, builderProviderType: provider } },
    });
    await expect(f.a.registerSubmission(3, before.revision, work, provider)).rejects.toThrow(
      "no longer matches",
    );
    const beforeRenewal = (await f.a.readClaim(3))!;
    await f.a.renew(3);
    expect(await f.b.readSubmission(3, work)).toMatchObject({
      record: { generation: beforeRenewal.record.generation },
    });
    const signed = f.bodies.get(3)!;
    f.bodies.set(3, { ...signed, body: signed.body.replace('"codex"', '"claude"') });
    await expect(f.b.readSubmission(3, work)).rejects.toThrow("signature is invalid");
    f.bodies.set(3, signed);
    f.setHead(base);
    expect(await f.b.readSubmission(3, work)).toBeNull();
    expect(await f.b.readSubmission(3, base)).toBeNull();
    const { revision } = (await f.a.readClaim(3))!;
    await expect(f.b.deleteCompletedClaim(3, revision)).rejects.toThrow("primary");
    expect(await f.a.deleteCompletedClaim(3, before.revision)).toBe(false);
    expect(await f.a.deleteCompletedClaim(3, revision)).toBe(true);
  });
});

it("rechecks primary authority and passes the observed revision when cleaning closed claims", async () => {
  const holdsPrimary = vi.fn(async () => true);
  const remove = vi.fn(async () => false);
  const reconcile = createClosedClaimCleanup({
    now: () => new Date(0),
    holdsPrimary,
    listIssues: async () => [
      { issue: 1, revision: "open" },
      { issue: 2, revision: "replaced" },
      { issue: 3, revision: "fenced" },
    ],
    isClosedIssue: async (issue) => {
      if (issue === 3) holdsPrimary.mockResolvedValue(false);
      return issue !== 1;
    },
    remove,
  });
  await Promise.all([reconcile(), reconcile()]);
  expect(remove.mock.calls).toEqual([[2, "replaced"]]);
});

it("uses expected-old Git pushes for create, update and deletion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vorteo-claim-git-"));
  const remote = join(directory, "remote");
  const local = join(directory, "local");
  try {
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    execFileSync("git", ["init", "--quiet", "--bare", local]);
    execFileSync("git", ["-C", local, "remote", "add", "origin", remote]);
    const chargeMutation = vi.fn(async () => {});
    const store = createGitClaimStore({
      cwd: local,
      repository: "test/factory",
      localRemote: remote,
      chargeMutation,
    });
    expect(await store.compareAndSwap(3, null, "first")).toBe(true);
    const first = (await store.read(3))!;
    expect(first.body).toBe("first");
    expect(await store.compareAndSwap(3, null, "competing create")).toBe(false);
    expect(await store.compareAndSwap(3, first.revision, "second")).toBe(true);
    const second = (await store.read(3))!;
    expect(await store.listIssues()).toEqual([{ issue: 3, revision: second.revision }]);
    expect(await store.compareAndSwap(3, first.revision, null)).toBe(false);
    expect(await store.compareAndSwap(3, second.revision, null)).toBe(true);
    expect(await store.read(3)).toBeNull();
    expect(await store.listIssues()).toEqual([]);
    expect(chargeMutation).toHaveBeenCalledTimes(5);
    const other = join(directory, "other");
    execFileSync("git", ["init", "--quiet", "--bare", other]);
    execFileSync("git", ["-C", local, "remote", "set-url", "--push", "origin", other]);
    await expect(store.compareAndSwap(3, null, "blocked")).rejects.toThrow(
      "matching canonical fetch and push URLs",
    );
    expect(execFileSync("git", ["-C", other, "for-each-ref"], { encoding: "utf8" })).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("uses unsigned Host CAS for dispatch and never returns submission authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "host-claim-fixture-"));
  const remote = join(directory, "remote");
  const a = join(directory, "a");
  const b = join(directory, "b");
  const git = (args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin", HOME: directory, GIT_ALLOW_PROTOCOL: "file" },
    });
  try {
    for (const dir of [remote, a, b]) git(["init", "--quiet", "--bare", dir]);
    for (const dir of [a, b]) git(["-C", dir, "remote", "add", "origin", remote]);
    let head: string | null = null;
    let now = Date.parse("2026-11-27T12:00:00Z");
    const storeFor = (cwd: string) =>
      createGitClaimStore({
        cwd,
        repository: "test/factory",
        localRemote: remote,
        chargeMutation: async () => {},
      });
    const port = (cwd: string, installation: string) =>
      createUnsignedHostLeasePort({
        repository: "test/factory",
        installation,
        refs: storeFor(cwd),
        now: () => new Date(now),
        prepare: async () => ({ brief: "fixture", checkedHeadSha: null }),
        readWorkHead: async () => head,
        ensureWorkBranch: async () => {
          head ??= base;
        },
        pushSavedWork: async () => {
          head = work;
          return work;
        },
        isPrimary: () => cwd === a,
      });
    const primary = port(a, "host_a");
    const other = port(b, "host_b");
    const acquired = await Promise.all([primary.acquire(3), other.acquire(3)]);
    expect(acquired.map((entry) => entry.outcome).sort()).toEqual(["claimed", "foreign"]);
    const seen = (await primary.readClaim(3))!;
    const winner = seen.record.installation === "host_a" ? primary : other;
    const peer = winner === primary ? other : primary;
    await peer.readClaim(3);
    expect(JSON.parse((await storeFor(a).read(3))!.body)).toMatchObject({
      kind: "unsigned-host",
      issue: 3,
      repository: "test/factory",
      record: { submission: null },
    });
    expect(await winner.readSubmission(3, base)).toBeNull();
    await expect(winner.registerSubmission(3, seen.revision, base, provider)).rejects.toThrow(
      "cannot register",
    );
    await winner.renew(3);
    expect((await peer.readClaim(3))?.record.generation).toBe(seen.record.generation);
    now += CLAIM_TTL_MS + 1;
    expect(await peer.acquire(3)).toMatchObject({
      outcome: "claimed",
      continueFrom: "factory/issue-3",
    });
    const takeover = (await primary.readClaim(3))!;
    expect(takeover.record.generation).not.toBe(seen.record.generation);
    await peer.release(3, "pause");
    const released = (await primary.readClaim(3))!;
    expect(released.record).toMatchObject({
      generation: takeover.record.generation,
      released: true,
      submission: null,
    });
    expect(head).toBe(work);
    await expect(other.deleteCompletedClaim(3, released.revision)).rejects.toThrow("primary");
    expect(await primary.deleteCompletedClaim(3, takeover.revision)).toBe(false);
    expect(await primary.deleteCompletedClaim(3, released.revision)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
