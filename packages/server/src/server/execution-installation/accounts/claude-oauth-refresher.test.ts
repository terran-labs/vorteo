import { z } from "zod";
import { HostRefreshDiagnosticsSchema } from "./host-owned-refresher.js";
import { expect, it, vi } from "vitest";
import { ClaudeOAuthRefresher, type ClaudeOAuthPolicy } from "./claude-oauth-refresher.js";
import {
  accessProjectionDigest,
  type ClaudeOAuthProjectionDelivery,
  type ClaudeOAuthProjectionReceipt,
} from "./claude-oauth-delivery.js";
import type { ClaudeOAuthGrant } from "./claude-oauth-storage.js";

// Frozen pre-repair schema: rollback readers must accept every authoritative state write.
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TargetSchema = z.strictObject({
  serverId: z.string().min(1),
  providerId: z.string().min(1),
  excluded: z.boolean(),
  appliedRotation: Counter.nullable(),
});
/** Secret-free by construction: digests, expiry and identity only, never a token. */
const RecordSchema = z.strictObject({
  definitionId: z.string().min(1),
  generation: Positive,
  rotation: Counter,
  signedIn: z.boolean(),
  hostGrant: z.enum(["present", "missing"]).nullable(),
  policyRevision: Positive,
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  expiresAt: Counter.nullable(),
  /** `orgId` is the provider's organization or workspace: Claude's org, Codex's ChatGPT account. */
  identity: z
    .strictObject({ email: z.string().nullable(), orgId: z.string().nullable() })
    .nullable(),
  checkedAt: Counter.nullable(),
  refresh: z
    .strictObject({ at: Counter, outcome: z.enum(["refreshed", "unchanged", "failed"]) })
    .nullable(),
  /** Consecutive refreshes of the current Host token that did not produce a newer one. */
  refreshFailures: Counter.default(0),
  /** Consecutive reconciles that left a rotation undelivered, and when to try again. */
  deliveryFailures: Counter.default(0),
  deliveryRetryAt: Counter.nullable().default(null),
  targets: z.array(TargetSchema),
});
const LegacyRefreshStateSchema = z.array(RecordSchema);

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const MINUTE = 60_000;

function harness(options: { excluded?: boolean } = {}) {
  let now = 1_000_000_000_000;
  let state: unknown = [];
  let diagnostics: unknown = [];
  let diagnosticFailure = false;
  let policy: ClaudeOAuthPolicy = {
    revision: 1,
    removed: false,
    targets: [
      { serverId: "dev", providerId: "claude-account-x", excluded: options.excluded ?? false },
    ],
  };
  let grant: ClaudeOAuthGrant | null = {
    accessToken: "synthetic-access-1",
    hasRefreshToken: true,
    expiresAt: now + 60 * MINUTE,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  };
  let online = true;
  let tokens = 1;
  let reads = 0;
  let readable = true;
  const deliveries: ClaudeOAuthProjectionDelivery[] = [];
  const persisted: string[] = [];
  // Option A: the official CLI rotates the token under its own locks.
  const refresh = vi.fn(async () => {
    tokens += 1;
    grant = { ...grant!, accessToken: `synthetic-access-${tokens}`, expiresAt: now + 60 * MINUTE };
  });
  const create = () =>
    new ClaudeOAuthRefresher({
      installationId: INSTALLATION,
      read: () => state,
      persist: (next) => {
        LegacyRefreshStateSchema.parse(next);
        state = structuredClone(next);
        persisted.push(JSON.stringify(next));
      },
      diagnostics: {
        read: () => {
          if (diagnosticFailure) throw new Error("sidecar unreadable");
          return diagnostics;
        },
        persist: (next) => {
          if (diagnosticFailure) throw new Error("sidecar unwritable");
          diagnostics = structuredClone(next);
        },
      },
      policy: () => policy,
      grant: async () => {
        reads += 1;
        if (!readable) throw new Error("Credential storage unavailable");
        return grant;
      },
      refresh,
      deliver: async (delivery): Promise<ClaudeOAuthProjectionReceipt> => {
        if (!online) throw new Error("Dev is offline");
        deliveries.push(structuredClone(delivery));
        const { access, ...slot } = delivery;
        return {
          ...slot,
          digest: accessProjectionDigest(access),
          phase: "applied",
          active: access !== null,
        };
      },
      now: () => now,
    });
  return {
    create,
    deliveries,
    persisted,
    diagnostics: () => HostRefreshDiagnosticsSchema.parse(diagnostics),
    setDiagnostics: (value: unknown) => {
      diagnostics = value;
    },
    setDiagnosticFailure: () => {
      diagnosticFailure = true;
    },
    refresh,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    reads: () => reads,
    setReadable: (value: boolean) => {
      readable = value;
    },
    setGrant: (value: ClaudeOAuthGrant | null) => {
      grant = value;
    },
    grant: () => grant,
    setPolicy: (value: ClaudeOAuthPolicy) => {
      policy = value;
    },
    policy: () => policy,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

it("projects the Host grant without refreshing far from expiry and never persists a token", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", { email: "owner@example.com", orgId: "org-1" });
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.deliveries).toHaveLength(1);
  expect(h.deliveries[0]).toMatchObject({
    generation: 1,
    rotation: 1,
    access: { accessToken: "synthetic-access-1", scopes: ["user:inference", "user:profile"] },
  });
  expect(Object.keys(h.deliveries[0]!.access!)).not.toContain("refreshToken");
  expect(refresher.status("one")).toMatchObject({
    signedIn: true,
    identity: { email: "owner@example.com" },
    environments: [{ serverId: "dev", status: "ready" }],
  });
  // An idle reconcile delivers nothing and leaves state untouched.
  const writes = h.persisted.length;
  await refresher.reconcile();
  expect(h.deliveries).toHaveLength(1);
  expect(h.persisted).toHaveLength(writes);
  for (const saved of h.persisted) expect(saved).not.toContain("synthetic-access");
  expect(JSON.stringify(h.diagnostics())).not.toContain("synthetic-access");
  // A restarted coordinator resumes from the same secret-free state.
  expect(h.create().status("one")).toEqual(refresher.status("one"));
});

it("refreshes once inside the lead window and delivers the new token as a new rotation", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.advance(56 * MINUTE + 30_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.deliveries.at(-1)).toMatchObject({
    rotation: 2,
    access: { accessToken: "synthetic-access-2" },
  });
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "refreshed" });
  h.advance(30_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
});

it("never refreshes without a refresh token or while every Dev target is excluded", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setGrant({ ...h.grant()!, hasRefreshToken: false });
  h.advance(57 * MINUTE);
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();

  const excluded = harness({ excluded: true });
  const idle = excluded.create();
  await idle.connected("one", null);
  excluded.advance(57 * MINUTE);
  await idle.reconcile();
  expect(excluded.refresh).not.toHaveBeenCalled();
  expect(excluded.deliveries).toEqual([expect.objectContaining({ access: null })]);
  expect(idle.status("one").environments).toEqual([{ serverId: "dev", status: "excluded" }]);
});

it("keeps an offline Dev pending and retries the same rotation from a fresh Host read", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  h.setOnline(false);
  await refresher.reconcile();
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "pending" }]);
  h.setOnline(true);
  h.advance(30_000);
  await refresher.reconcile();
  expect(h.deliveries).toEqual([
    expect.objectContaining({
      rotation: 1,
      access: expect.objectContaining({ expiresAt: expect.any(Number) }),
    }),
  ]);
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "ready" }]);
});

it("withdraws Dev and asks for sign-in when the Host grant disappears", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setGrant(null);
  h.advance(6 * MINUTE);
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ rotation: 2, access: null });
  expect(refresher.status("one")).toMatchObject({
    needsSignIn: true,
    environments: [{ serverId: "dev", status: "disconnected" }],
  });
});

it("starts a new generation that withdraws Dev on sign-out, and another on reconnect", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  const signOut = refresher.signedOut("one");
  await expect(refresher.recover("one")).rejects.toThrow();
  await signOut;
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 2, rotation: 0, access: null });
  expect(refresher.status("one")).toMatchObject({
    signedIn: false,
    environments: [{ serverId: "dev", status: "disconnected" }],
  });
  await refresher.connected("one", null);
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 3, rotation: 1 });
});

it("re-delivers under a new rotation after a policy change", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setPolicy({ ...h.policy(), revision: 2 });
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ policyRevision: 2, rotation: 2 });
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "ready" }]);
});

it("records a failed refresh and retries it after a minute", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockRejectedValueOnce(new Error("CLI unavailable"));
  h.advance(57 * MINUTE);
  await refresher.reconcile();
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "failed" });
  h.advance(30_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  h.advance(31_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(2);
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "refreshed" });
});

async function tick(refresher: ClaudeOAuthRefresher, h: ReturnType<typeof harness>, count: number) {
  for (let index = 0; index < count; index++) {
    await refresher.reconcile();
    h.advance(30_000);
  }
}

it("keeps an expired grant recoverable through a prolonged outage without asking for sign-in", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockImplementation(async () => {
    throw new Error("network down");
  });
  h.advance(56 * MINUTE);
  await tick(refresher, h, 240);
  expect(h.refresh.mock.calls.length).toBeGreaterThan(3);
  expect(h.refresh.mock.calls.length).toBeLessThanOrEqual(27);
  expect(h.deliveries).toHaveLength(1);
  expect(refresher.status("one")).toMatchObject({
    needsSignIn: false,
    environments: [{ serverId: "dev", status: "pending" }],
  });
  h.refresh.mockImplementation(async () => {
    h.setGrant({
      ...h.grant()!,
      accessToken: "synthetic-access-recovered",
      expiresAt: h.now() + 60 * MINUTE,
    });
  });
  h.advance(5 * MINUTE);
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({
    access: { accessToken: "synthetic-access-recovered" },
  });
  expect(refresher.status("one")).toMatchObject({
    needsSignIn: false,
    environments: [{ serverId: "dev", status: "ready" }],
  });
});

it("delivers a saved rotation even when the CLI subsequently fails", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockImplementation(async () => {
    h.setGrant({ ...h.grant()!, accessToken: "synthetic-saved", expiresAt: h.now() + 60 * MINUTE });
    throw new Error("request timed out after saving");
  });
  h.advance(56 * MINUTE);
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ access: { accessToken: "synthetic-saved" } });
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "refreshed" });
});

it("preserves the last grant on an unreadable refresh result, but withdraws a confirmed missing grant", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockImplementation(async () => {
    h.setReadable(false);
    throw new Error("request failed");
  });
  h.advance(56 * MINUTE);
  await refresher.reconcile();
  expect(h.deliveries).toHaveLength(1);
  expect(refresher.status("one").needsSignIn).toBe(false);
  h.setReadable(true);
  h.refresh.mockImplementation(async () => {
    h.setGrant(null);
    throw new Error("grant revoked");
  });
  h.advance(5 * MINUTE);
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ access: null });
  expect(refresher.status("one").needsSignIn).toBe(true);
});

it("renews before expiry for an unreachable Dev while backing off delivery", async () => {
  const h = harness();
  const refresher = h.create();
  h.setOnline(false);
  await refresher.connected("one", null);
  await tick(refresher, h, 120);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.reads()).toBeLessThanOrEqual(20);
  h.setOnline(true);
  await tick(refresher, h, 12);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.deliveries.at(-1)).toMatchObject({ access: { accessToken: "synthetic-access-2" } });
});

it("reconstructs both accounts and renews concurrently before expiry", async () => {
  let now = 1_000_000_000_000;
  const originalExpiry = now + 60 * MINUTE;
  let state: unknown = [];
  const grants = new Map<string, ClaudeOAuthGrant>(
    ["slow", "fast"].map((id) => [
      id,
      {
        accessToken: `synthetic-${id}`,
        hasRefreshToken: true,
        expiresAt: originalExpiry,
        scopes: [],
      },
    ]),
  );
  let releaseSlow: (() => void) | null = null;
  const refresh = vi.fn(async (definitionId: string) => {
    if (definitionId === "slow")
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
    grants.set(definitionId, { ...grants.get(definitionId)!, expiresAt: now + 60 * MINUTE });
  });
  const create = () =>
    new ClaudeOAuthRefresher({
      installationId: INSTALLATION,
      read: () => state,
      persist: (next) => {
        state = structuredClone(next);
      },
      policy: (definitionId) => ({
        revision: 1,
        removed: false,
        targets: [
          { serverId: "dev", providerId: `claude-account-${definitionId}`, excluded: false },
        ],
      }),
      grant: async (definitionId) => grants.get(definitionId) ?? null,
      refresh,
      deliver: async (delivery) => {
        const { access, ...slot } = delivery;
        return {
          ...slot,
          digest: accessProjectionDigest(access),
          phase: "applied",
          active: access !== null,
        };
      },
      now: () => now,
    });
  let refresher = create();
  await refresher.connected("slow", null);
  await refresher.connected("fast", null);
  await refresher.reconcile();
  expect(refresh).not.toHaveBeenCalled();
  refresher = create();
  now += 57 * MINUTE;
  expect(now).toBeLessThan(originalExpiry);
  const running = refresher.reconcile();
  const recovery = refresher.recover("fast");
  await vi.waitFor(() => {
    expect(releaseSlow).not.toBeNull();
    expect(grants.get("fast")!.expiresAt).toBe(now + 60 * MINUTE);
  });
  releaseSlow!();
  await Promise.all([running, recovery]);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(grants.get("slow")!.expiresAt).toBeGreaterThan(originalExpiry);
  expect(grants.get("fast")!.expiresAt).toBeGreaterThan(originalExpiry);
});

it("renews a Host-only account and respects Host exclusion", async () => {
  const h = harness();
  h.setPolicy({ revision: 1, removed: false, hostEnabled: true, targets: [] });
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.advance(57 * MINUTE);
  await Promise.all([refresher.reconcile(), refresher.recover("one"), refresher.recover("one")]);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  h.setPolicy({ revision: 2, removed: false, hostEnabled: false, targets: [] });
  h.advance(57 * MINUTE);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
});

it("preserves expiry on unreadable storage and records each missed expiry once", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  const expiresAt = h.grant()!.expiresAt;
  h.setReadable(false);
  h.advance(61 * MINUTE);
  await refresher.reconcile();
  const saved = JSON.parse(h.persisted.at(-1)!)[0];
  expect(saved).toMatchObject({
    expiresAt,
    refreshFailures: 1,
  });
  expect(h.diagnostics()[0]).toMatchObject({
    missedExpiry: expiresAt,
    failureReason: "storage_unreadable",
  });
  await h.create().reconcile();
  expect(JSON.parse(h.persisted.at(-1)!)[0]).toEqual(saved);
  expect(h.deliveries).toHaveLength(1);
});

it("records a missed expiry when renewal is ineligible without repeating every tick", async () => {
  const h = harness();
  h.setGrant({ ...h.grant()!, hasRefreshToken: false });
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.advance(61 * MINUTE);
  await refresher.reconcile();
  const saved = JSON.parse(h.persisted.at(-1)!)[0];
  expect(saved).toMatchObject({ refresh: null, refreshFailures: 0 });
  expect(h.diagnostics()[0]).toMatchObject({ missedExpiry: h.grant()!.expiresAt });
  h.advance(30_000);
  await refresher.reconcile();
  expect(JSON.parse(h.persisted.at(-1)!)[0]).toMatchObject({
    refresh: saved.refresh,
    refreshFailures: saved.refreshFailures,
  });
});

it("retains missed expiry evidence when the overdue grant immediately renews", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  const originalExpiry = h.grant()!.expiresAt;
  h.advance(61 * MINUTE);
  await refresher.reconcile();
  expect(JSON.parse(h.persisted.at(-1)!)[0]).toMatchObject({
    refreshFailures: 0,
    refresh: { outcome: "refreshed" },
  });
  expect(h.diagnostics()[0]).toMatchObject({ missedExpiry: originalExpiry });
  expect(h.diagnostics()[0]?.failureReason).toBeUndefined();
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
});

it("missed expiry preserves an existing failed refresh retry deadline", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockRejectedValue(new Error("refresh failed"));
  h.advance(56 * MINUTE);
  await refresher.reconcile();
  h.advance(MINUTE);
  await refresher.reconcile();
  h.advance(2 * MINUTE);
  await refresher.reconcile();
  const failed = JSON.parse(h.persisted.at(-1)!)[0];
  expect(failed.refreshFailures).toBe(3);
  h.advance(MINUTE);
  await refresher.reconcile();
  expect(JSON.parse(h.persisted.at(-1)!)[0]).toMatchObject({
    refresh: failed.refresh,
    refreshFailures: 3,
  });
  expect(h.diagnostics()[0]?.missedExpiry).toBe(h.grant()!.expiresAt);
  h.advance(3 * MINUTE - 1);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(3);
  h.advance(1);
  await h.create().reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(4);
});

it.each(["unreadable", "missing"])(
  "clears a recovered %s read without fast polling",
  async (kind) => {
    const h = harness();
    const refresher = h.create();
    await refresher.connected("one", null);
    await refresher.reconcile();
    const grant = h.grant();
    if (kind === "unreadable") h.setReadable(false);
    else h.setGrant(null);
    h.advance(5 * MINUTE);
    await refresher.reconcile();
    expect(JSON.parse(h.persisted.at(-1)!)[0].refreshFailures).toBe(1);
    h.setReadable(true);
    h.setGrant(grant);
    h.advance(MINUTE);
    const restarted = h.create();
    await restarted.reconcile();
    expect(JSON.parse(h.persisted.at(-1)!)[0].refreshFailures).toBe(0);
    expect(h.diagnostics()[0]?.failureReason).toBeUndefined();
    const reads = h.reads();
    h.advance(MINUTE);
    await restarted.reconcile();
    expect(h.reads()).toBe(reads);
  },
);

it("keeps genuine refresh failures when a later storage read recovers", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockRejectedValue(new Error("refresh failed"));
  h.advance(56 * MINUTE);
  await refresher.reconcile();
  h.advance(MINUTE);
  h.setReadable(false);
  await refresher.reconcile();
  h.setReadable(true);
  h.advance(2 * MINUTE);
  const restarted = h.create();
  await restarted.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(2);
  expect(JSON.parse(h.persisted.at(-1)!)[0].refreshFailures).toBe(2);
  expect(h.diagnostics()[0]?.failureReason).toBe("refresh_failed");
  h.advance(MINUTE);
  await restarted.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(2);
});

it("ignores unavailable or stale optional diagnostics while legacy state remains readable", async () => {
  const h = harness();
  let refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setDiagnostics({ corrupt: true });
  expect(h.create().status("one").signedIn).toBe(true);
  h.setDiagnostics([
    { definitionId: "one", generation: 99, refreshAt: null, refreshFailures: 0, missedExpiry: 1 },
  ]);
  refresher = h.create();
  h.advance(5 * MINUTE);
  await refresher.reconcile();
  expect(h.diagnostics()[0]?.missedExpiry).toBeUndefined();
  h.setDiagnosticFailure();
  refresher = h.create();
  h.advance(56 * MINUTE);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  for (const saved of h.persisted)
    expect(LegacyRefreshStateSchema.safeParse(JSON.parse(saved)).success).toBe(true);
});

it("ignores a stale read-failure sidecar when restoring genuine refresh backoff", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockRejectedValue(new Error("refresh failed"));
  h.advance(56 * MINUTE);
  await refresher.reconcile();
  const stale = h.diagnostics();
  stale[0]!.refreshAt = 0;
  stale[0]!.failureReason = "storage_unreadable";
  h.setDiagnostics(stale);
  const restarted = h.create();
  h.advance(MINUTE);
  await restarted.reconcile();
  expect(JSON.parse(h.persisted.at(-1)!)[0].refreshFailures).toBe(2);
});
