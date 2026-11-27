import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createGitClaimStore } from "./claim-git.js";
import { CLAIM_TTL_MS, createMachineLeasePort, type ClaimRefStore } from "./claims.js";

const base = "a".repeat(40);
const work = "b".repeat(40);
const provider = "codex";

function fixture() {
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
        return Boolean(key && verify(null, bytes, key, Buffer.from(signature, "base64")));
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

it("uses expected-old Git pushes for create, update and deletion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vorteo-claim-git-"));
  const remote = join(directory, "remote");
  const local = join(directory, "local");
  try {
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    execFileSync("git", ["init", "--quiet", "--bare", local]);
    execFileSync("git", ["-C", local, "remote", "add", "origin", remote]);
    const chargeMutation = vi.fn(async () => {});
    const store = createGitClaimStore({ cwd: local, chargeMutation });
    expect(await store.compareAndSwap(3, null, "first")).toBe(true);
    const first = (await store.read(3))!;
    expect(first.body).toBe("first");
    expect(await store.compareAndSwap(3, null, "competing create")).toBe(false);
    expect(await store.compareAndSwap(3, first.revision, "second")).toBe(true);
    const second = (await store.read(3))!;
    expect(await store.compareAndSwap(3, first.revision, null)).toBe(false);
    expect(await store.compareAndSwap(3, second.revision, null)).toBe(true);
    expect(await store.read(3)).toBeNull();
    expect(chargeMutation).toHaveBeenCalledTimes(5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
