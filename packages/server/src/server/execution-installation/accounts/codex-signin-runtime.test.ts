import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import type { ProviderLoginSession } from "../../../services/provider-login/session.js";
import express from "express";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { createCodexSignInRuntime } from "./codex-signin-runtime.js";
import { mountCodexSignInConsumer } from "./codex-signin-consumer.js";
import {
  ACTIVE_DEV_SESSION,
  IDENTITY_CHANGED,
  OTHER_UNREADABLE_RECORD,
  SAME_GRANT_BUSY,
  STOPPING,
  TOO_MANY_FOLDERS,
  UNREADABLE_RECORD,
} from "./codex-signin-adoption.js";
import { writeClaudeSetupFile } from "./claude-setup-file.js";
import { codexOtherSession } from "./codex-signin-identity.js";
import { adoptionView, mountCodexSignInRoutes } from "./codex-signin-routes.js";
import {
  codexProjectionDigest,
  type CodexSignInProjectionDelivery,
} from "./codex-signin-delivery.js";
import type { CodexHostCli, CodexHostGrant } from "./codex-signin-host.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const SUPPORTED = { installationSettingsAuthority: true, codexInstallationSignIn: true };

function harness(
  options: {
    bindings?: (providerId: string) => Record<string, string>;
    devFeatures?: { installationSettingsAuthority?: boolean; codexInstallationSignIn?: boolean };
    accountSetup?: boolean;
  } = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-signin-runtime-"));
  directories.push(stateDir);
  const creationId = randomUUID();
  const providerId = `codex-account-${creationId}`;
  const config = {
    stateDir,
    public: {
      installationId: randomUUID(),
      environments: [
        { serverId: "host", kind: "host" },
        { serverId: "dev", kind: "container" },
      ],
    },
    host: { endpoint: "127.0.0.1:1", password: "synthetic-host-password" },
    container: { endpoint: "127.0.0.1:2", password: "synthetic-dev-password" },
  } as unknown as InstallationConfig;
  let revision = 1;
  let definitions: InstallationProvider[] = [
    {
      id: "one",
      providerType: "codex",
      ...(options.accountSetup === false
        ? {}
        : { accountSetup: { provider: "codex", creationId } }),
      bindings: options.bindings?.(providerId) ?? { host: providerId },
      policy: { enabled: true, label: "ChatGPT Pro" },
    },
  ];
  const snapshot = () => ({
    revision,
    settings: { providerDefinitions: definitions, resourceExclusions: {} },
  });
  const settings = {
    snapshot,
    update: vi.fn(async (input: { settings: { providerDefinitions: InstallationProvider[] } }) => {
      definitions = input.settings.providerDefinitions;
      revision += 1;
      return snapshot();
    }),
    reconcile: vi.fn(async () => snapshot()),
  } as unknown as InstallationSettingsService;
  const codexHome = `/host/codex-accounts/${providerId}`;
  const deliveries: CodexSignInProjectionDelivery[] = [];
  const authorizations: string[] = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    authorizations.push(`${String(url)} ${headers.get("Authorization")}`);
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/api/installation/codex/signin/binding"))
      return Response.json({ providerId: body.providerId, codexHome });
    deliveries.push(body);
    const { access, ...slot } = body as CodexSignInProjectionDelivery;
    return Response.json({
      ...slot,
      digest: codexProjectionDigest(access),
      phase: "applied",
      active: access !== null,
    });
  });
  let complete: ((success: boolean) => void) | null = null;
  const session: ProviderLoginSession = {
    scope: codexHome,
    start: async (onComplete) => {
      complete = onComplete;
      return { verificationUrl: "https://auth.openai.com/codex/device", userCode: "SYNT-HETC" };
    },
    readAccountLabel: async () => "owner@example.com",
    cancel: async () => {},
    dispose: async () => {},
  };
  const cli = {
    openRefresh: vi.fn(async () => ({
      refresh: async () => "done" as const,
      close: async () => {},
    })),
    logout: vi.fn(async () => {}),
    identity: vi.fn(async () => ({ email: "owner@example.com", orgId: "workspace-1" })),
    loginSession: vi.fn(async () => session),
  };
  const grant: CodexHostGrant = {
    accessToken: "synthetic-access-token",
    idToken: "synthetic-id-token",
    accountId: "workspace-1",
    hasRefreshToken: true,
    expiresAt: Date.now() + 10 * 86_400_000,
    lastRefresh: new Date().toISOString(),
  };
  const readGrant = vi.fn(() => grant);
  const daemonFeatures = vi.fn(async (kind: "host" | "container") =>
    kind === "container" ? (options.devFeatures ?? SUPPORTED) : SUPPORTED,
  );
  const runtime = createCodexSignInRuntime(config, settings, undefined, {
    daemonFeatures,
    cli: cli as unknown as CodexHostCli,
    readGrant,
    fetch: fetchFake as unknown as typeof fetch,
  });
  return {
    runtime,
    settings,
    cli,
    readGrant,
    deliveries,
    authorizations,
    codexHome,
    providerId,
    stateDir,
    complete: (success: boolean) => complete?.(success),
    definitions: () => definitions,
  };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

it("signs in once on the Host, reaches Dev without a second sign-in and signs out once", async () => {
  const h = harness();
  await h.runtime.start("one");
  // The connection flow binds every environment; it never asks which one.
  expect(h.definitions()[0]?.bindings).toEqual({ host: h.providerId, dev: h.providerId });
  expect(h.settings.reconcile).toHaveBeenCalled();
  await until(() => h.runtime.read("one").login.status === "waiting");
  expect(h.cli.loginSession).toHaveBeenCalledWith(h.codexHome);
  h.complete(true);
  await until(() => h.deliveries.length === 1);
  expect(h.readGrant).toHaveBeenCalledWith(h.codexHome);
  expect(h.deliveries[0]).toMatchObject({
    serverId: "dev",
    providerId: h.providerId,
    generation: 1,
    rotation: 1,
    access: { accessToken: "synthetic-access-token", accountId: "workspace-1" },
  });
  expect(JSON.stringify(h.deliveries[0])).not.toContain("refresh");
  expect(h.authorizations[0]).toBe(
    "http://127.0.0.1:1/api/installation/codex/signin/binding Bearer synthetic-host-password",
  );
  expect(h.authorizations).toContain(
    "http://127.0.0.1:2/api/installation/codex/signin/projection Bearer synthetic-dev-password",
  );
  await until(() => h.runtime.read("one").connection.environments[0]?.status === "ready");
  expect(h.runtime.read("one").connection).toMatchObject({
    signedIn: true,
    identity: { email: "owner@example.com", orgId: "workspace-1" },
  });
  const state = readFileSync(join(h.stateDir, "codex-signin", "state.json"), "utf8");
  expect(state).not.toContain("synthetic-access-token");
  expect(state).not.toContain("synthetic-id-token");

  await expect(h.runtime.signOut("one")).resolves.toBeNull();
  expect(h.cli.logout).toHaveBeenCalledWith(h.codexHome);
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 2, rotation: 0, access: null });
  expect(h.runtime.read("one").connection).toMatchObject({
    signedIn: false,
    environments: [{ serverId: "dev", status: "disconnected" }],
  });
});

it("keeps refreshing a managed account without a lease on a Host from before the lease", async () => {
  const h = harness();
  // Near expiry from the start, so the first Host read after sign-in refreshes.
  h.readGrant.mockReturnValue({ ...h.readGrant(), expiresAt: Date.now() + 10 * 60_000 });
  await h.runtime.start("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  h.complete(true);
  await until(() => h.deliveries.length === 1);
  // The Host advertises no codexAccountAdoption, so it has no lease route to ask.
  await h.runtime.reconcile();
  expect(h.cli.openRefresh).toHaveBeenCalledWith(h.codexHome);
  expect(h.authorizations.some((item) => item.includes("/signin/lease"))).toBe(false);
  await until(() => h.runtime.read("one").connection.refresh !== null);
  expect(h.runtime.read("one").connection.refresh?.outcome).not.toBe("failed");
});

it("reports a failed Host sign-out but still withdraws Dev", async () => {
  const h = harness();
  await h.runtime.start("one");
  h.cli.logout.mockRejectedValueOnce(new Error("Codex unavailable"));
  await expect(h.runtime.signOut("one")).resolves.toContain("did not finish on the Host");
  expect(h.deliveries.at(-1)).toMatchObject({ access: null });
});

it("refuses to start until every daemon can receive Codex projections", async () => {
  const h = harness({ devFeatures: { installationSettingsAuthority: true } });
  await expect(h.runtime.start("one")).rejects.toThrow();
  expect(h.settings.update).not.toHaveBeenCalled();
  expect(h.cli.loginSession).not.toHaveBeenCalled();
});

it("refuses unlinked accounts instead of consolidating them by label", async () => {
  const unlinked = harness({ accountSetup: false });
  await expect(unlinked.runtime.start("one")).rejects.toThrow();
  const mixed = harness({ bindings: (id) => ({ host: id, dev: "codex-account-other" }) });
  await expect(mixed.runtime.start("one")).rejects.toThrow();
  expect(mixed.settings.update).not.toHaveBeenCalled();
  expect(mixed.cli.loginSession).not.toHaveBeenCalled();
});

const DAY = 86_400_000;
/** The Host sign-in's login session; a Dev token with these claims is a copy of that sign-in. */
const HOST_SESSION = { sid: "host-session", auth_time: 1_700_000_000 };
/**
 * The record shape the first adoption release (72c38491) reads strictly, copied here on
 * purpose: a field this release adds to `adoption.json` itself fails it, and a rolled-back
 * coordinator would stop reading the file.
 */
const InstalledDigest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable()
  .optional();
const InstalledTarget = z.strictObject({
  realpath: z.string().startsWith("/").max(4096),
  dev: z.string().regex(/^\d{1,20}$/),
  ino: z.string().regex(/^\d{1,20}$/),
});
const InstalledCounter = z.number().int().nonnegative();
const InstalledJournalSchema = z.array(
  z.strictObject({
    definitionId: z.string().min(1),
    status: z.enum([
      "verifying-host",
      "pinning",
      "projecting",
      "adopted",
      "failed",
      "cancelled",
      "needs-owner-confirmation",
      "unadopting",
      "unadopted",
    ]),
    devServerId: z.string().min(1),
    devProviderId: z.string().min(1),
    hostProviderId: z.string().min(1),
    target: InstalledTarget.nullable(),
    startedAt: InstalledCounter,
    projectedAt: InstalledCounter.nullable(),
    projectedExpiresAt: InstalledCounter.nullable(),
    renewedAt: InstalledCounter.nullable(),
    provenAt: InstalledCounter.nullable(),
    copyForgottenAt: InstalledCounter.nullable(),
    replacedLocallyAt: InstalledCounter.nullable(),
    fallback: z.literal("host-sign-in"),
    restored: z
      .strictObject({ copyAgeMs: InstalledCounter, mayNeedSignIn: z.literal(true) })
      .nullable(),
    restoreSkipped: z.literal(true).optional(),
    copies: z
      .array(z.strictObject({ target: InstalledTarget, savedSince: InstalledCounter }))
      .max(8)
      .optional(),
    heldIdentityDigest: InstalledDigest,
    expectedIdentityDigest: InstalledDigest,
    pendingIdentityDigest: InstalledDigest,
    copyDeleteBlocked: z.string().max(300).nullable().optional(),
    hostIdentityDigest: InstalledDigest,
    error: z.string().max(300).nullable(),
  }),
);
const FULL_SUPPORT = { ...SUPPORTED, codexAccountAdoption: true };

/** Unsigned synthetic JWT carrying the email Codex shows and its login session's claims. */
function idToken(
  email: string,
  person = "person-1",
  session: { sid?: string; auth_time?: number } = HOST_SESSION,
) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = {
    email,
    sub: person,
    ...session,
    "https://api.openai.com/auth": { chatgpt_user_id: person },
  };
  return `${encode({ alg: "none" })}.${encode(claims)}.synthetic`;
}

/**
 * Legacy Codex definitions: an `accountId`, no `accountSetup`, a managed Host binding and the
 * Dev binding each had before the installation managed Codex.
 */
function legacyHarness(
  options: {
    retention?: InstallationConfig["codexAdoptionRetention"];
    devFeatures?: Record<string, boolean>;
  } = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-adoption-"));
  directories.push(stateDir);
  let now = 2_000_000_000_000;
  const config = {
    stateDir,
    public: {
      installationId: randomUUID(),
      environments: [
        { serverId: "host", kind: "host" },
        { serverId: "dev", kind: "container" },
      ],
    },
    host: { endpoint: "127.0.0.1:1", password: "synthetic-host-password" },
    container: { endpoint: "127.0.0.1:2", password: "synthetic-dev-password" },
    ...(options.retention ? { codexAdoptionRetention: options.retention } : {}),
  } as unknown as InstallationConfig;
  const legacy = (id: string, dev: string): InstallationProvider => ({
    id,
    providerType: "codex",
    accountId: randomUUID(),
    bindings: { host: `codex-account-${randomUUID()}`, dev },
    policy: { enabled: true, label: id },
  });
  let definitions = [legacy("one", "codex-primary"), legacy("two", "codex-secondary")];
  let excluded: string[] = [];
  let revision = 1;
  const snapshot = () => ({
    revision,
    settings: {
      providerDefinitions: definitions,
      resourceExclusions: excluded.length
        ? { dev: { providerIds: excluded, terminalProfileIds: [], metadataProviderIds: [] } }
        : {},
    },
  });
  const settings = {
    snapshot,
    update: vi.fn(async () => snapshot()),
    reconcile: vi.fn(async () => snapshot()),
  } as unknown as InstallationSettingsService;
  const dev = {
    online: true,
    active: false,
    leaseGranted: true,
    /** An idle Host session on the account is loaded. */
    loaded: false,
    refreshOutcome: "done" as "done" | "timed-out",
    /** Startup time of the Host Codex process. */
    startupMs: 0,
    refusal: null as string | null,
    /** Dev's restore answer: a copy put back, or nothing (none saved, or auth.json already there). */
    restoreFound: true,
    /** Dev advertises `codexLegacyPinByPath`. */
    pinByPath: false,
    /** What Dev's inspect finds in the adopted home's auth.json. */
    signIn: "projection" as "projection" | "none" | "other",
    /** Dev advertises `codexLegacySessionHold`. */
    sessionHold: false,
    /** The ID token of Dev's own refresh sign-in, or null without one. Another login by default. */
    signedIn: idToken("owner@example.com", "person-1", {
      sid: "dev-session",
      auth_time: 1_600_000_000,
    }) as string | null,
    /** A thread on the account starts or runs a turn, with these titles. */
    busy: [] as string[],
    /** Every nonce the coordinator sent Dev, by session check or delivery. */
    nonces: [] as string[],
    targets: {
      "codex-primary": { realpath: "/home/paseo/codex-primary", dev: "41", ino: "1001" },
      "codex-secondary": { realpath: "/home/paseo/codex-secondary", dev: "41", ino: "1002" },
    } as Record<string, { realpath: string; dev: string; ino: string }>,
  };
  const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
  const deliveries: Array<CodexSignInProjectionDelivery & { adoption?: unknown }> = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(url)).pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init?.body));
    requests.push({ route, body });
    if (route === "binding")
      return Response.json({ providerId: body.providerId, codexHome: `/host/${body.providerId}` });
    if (route === "lease") {
      order.push(body.operation);
      return Response.json(
        body.operation === "acquire" && dev.leaseGranted
          ? { granted: true, leaseId: randomUUID(), expiresAt: now + 30_000, loaded: dev.loaded }
          : { granted: false },
      );
    }
    if (!dev.online) throw new TypeError("fetch failed");
    if (route === "legacy") {
      if (body.operation === "pin") return Response.json({ target: dev.targets[body.providerId] });
      if (body.operation === "session-check") {
        if (body.sessionCheck) dev.nonces.push(body.sessionCheck.nonce);
        return Response.json({
          different: dev.signedIn === null || codexOtherSession(dev.signedIn, body.sessionCheck),
          active: dev.busy.length > 0,
          titles: dev.busy.slice(0, 3),
          more: Math.max(0, dev.busy.length - 3),
        });
      }
      if (body.operation === "sessions") return Response.json({ active: dev.active });
      if (body.operation === "inspect")
        return Response.json({ target: dev.targets[body.providerId], signIn: dev.signIn });
      if (body.operation === "restore")
        return Response.json(
          dev.restoreFound ? { restored: true, copyAgeMs: 5_000 } : { restored: false },
        );
      return Response.json({ forgotten: true });
    }
    if (dev.refusal)
      return Response.json({ error: "pending", reason: dev.refusal }, { status: 409 });
    deliveries.push(body);
    if (body.adoption?.sessionCheck) dev.nonces.push(body.adoption.sessionCheck.nonce);
    const { access, adoption: _adoption, ...slot } = body;
    return Response.json({
      ...slot,
      digest: codexProjectionDigest(access),
      phase: "applied",
      active: access !== null,
    });
  });
  const order: string[] = [];
  // The official Host Codex renews its own grant when the refresh completes.
  const refresh = vi.fn(async (_timeoutMs: number) => {
    order.push("refresh");
    if (dev.refreshOutcome === "done")
      grant = { ...grant, accessToken: "synthetic-renewed", expiresAt: now + 10 * DAY };
    return dev.refreshOutcome;
  });
  const cli = {
    openRefresh: vi.fn(async () => {
      order.push("open");
      now += dev.startupMs;
      return {
        refresh,
        close: async () => {
          order.push("close");
        },
      };
    }),
    logout: vi.fn(async () => {}),
    identity: vi.fn(async () => null),
    loginSession: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  let grant: CodexHostGrant = {
    accessToken: "synthetic-access-token",
    idToken: idToken("owner@example.com"),
    accountId: "workspace-1",
    hasRefreshToken: true,
    expiresAt: now + 10 * DAY,
    lastRefresh: new Date(now).toISOString(),
  };
  const usage = { status: "available" as const, fetchedAt: null as string | null };
  const runtime = createCodexSignInRuntime(config, settings, undefined, {
    daemonFeatures: async (kind) =>
      kind === "container"
        ? {
            ...(options.devFeatures ?? FULL_SUPPORT),
            codexLegacyPinByPath: dev.pinByPath,
            codexLegacySessionHold: dev.sessionHold,
          }
        : FULL_SUPPORT,
    cli: cli as unknown as CodexHostCli,
    readGrant: () => grant,
    fetch: fetchFake as unknown as typeof fetch,
    now: () => now,
    devUsage: async () => ({ ...usage, authRecovery: false }),
  });
  return {
    runtime,
    settings,
    cli,
    refresh,
    order,
    dev,
    requests,
    deliveries,
    usage,
    stateDir,
    legacyCalls: (operation: string) =>
      requests.filter((item) => item.route === "legacy" && item.body.operation === operation),
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setGrant: (value: Partial<CodexHostGrant>) => {
      grant = { ...grant, ...value };
    },
    exclude: (id: string) => {
      excluded = [id];
      revision += 1;
    },
    rebindDev: (id: string, providerId: string) => {
      const changed = definitions.find((item) => item.id === id)!;
      changed.bindings = { ...changed.bindings, dev: providerId };
      revision += 1;
    },
    journal: () => readFileSync(join(stateDir, "codex-signin", "adoption.json"), "utf8"),
    writeJournal: (records: unknown[]) =>
      writeClaudeSetupFile(join(stateDir, "codex-signin", "adoption.json"), records),
    /** As a rolled-back coordinator would read the records. */
    installedJournal: () =>
      InstalledJournalSchema.parse(
        JSON.parse(readFileSync(join(stateDir, "codex-signin", "adoption.json"), "utf8")),
      ),
    removeExtra: () => rmSync(join(stateDir, "codex-signin", "adoption-extra.json")),
  };
}

async function adopted(h: ReturnType<typeof legacyHarness>, id = "one") {
  await h.runtime.adopt(id);
  await h.runtime.reconcile();
  expect(h.runtime.adoption(id)?.status).toBe("adopted");
}

it("adopts a legacy account in place from the Host file alone and starts no Codex", async () => {
  const h = legacyHarness();
  // Nothing is adopted without the owner's selection.
  await h.runtime.reconcile();
  expect(h.deliveries).toEqual([]);
  expect(h.runtime.adoption("one")).toBeNull();

  await expect(h.runtime.adopt("one")).resolves.toMatchObject({ status: "projecting" });
  expect(h.deliveries[0]).toMatchObject({
    serverId: "dev",
    providerId: "codex-primary",
    access: { accessToken: "synthetic-access-token" },
    adoption: { target: h.dev.targets["codex-primary"], keepLocalSignIn: true },
  });
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "adopted",
    devProviderId: "codex-primary",
    fallback: "host-sign-in",
  });
  // The binding, the definition and the Host sign-in stay as they were.
  expect(h.settings.update).not.toHaveBeenCalled();
  for (const operation of [h.cli.openRefresh, h.cli.identity, h.cli.logout, h.cli.loginSession])
    expect(operation).not.toHaveBeenCalled();
  expect(h.journal()).not.toMatch(/synthetic-access|owner@example.com|workspace-1/);
  expect(h.runtime.read("one").connection).toMatchObject({
    identity: { email: "owner@example.com", orgId: "workspace-1" },
    environments: [{ serverId: "dev", status: "ready" }],
  });
});

it("fails closed with nothing written when the Host, Dev or a daemon is not ready", async () => {
  const expiring = legacyHarness();
  expiring.setGrant({ expiresAt: expiring.now() + 20 * 60_000 });
  await expect(expiring.runtime.adopt("one")).resolves.toMatchObject({
    status: "failed",
    error: "The Host's sign-in for this account is about to renew. Try again in a few minutes.",
  });
  expect(expiring.requests.filter((item) => item.route !== "binding")).toEqual([]);

  // A Dev without codexLegacySessionHold keeps refusing while any session is loaded.
  const busy = legacyHarness();
  busy.dev.active = true;
  await expect(busy.runtime.adopt("one")).resolves.toMatchObject({
    status: "failed",
    error: "A Dev session is using this account. Stop it, then try again.",
  });
  expect(busy.legacyCalls("pin")).toEqual([]);
  expect(busy.legacyCalls("session-check")).toEqual([]);
  expect(busy.deliveries).toEqual([]);

  const outdated = legacyHarness({ devFeatures: SUPPORTED });
  await expect(outdated.runtime.adopt("one")).resolves.toMatchObject({ status: "failed" });
  expect(outdated.requests).toEqual([]);
  for (const h of [expiring, busy, outdated]) {
    expect(h.settings.update).not.toHaveBeenCalled();
    expect(h.cli.openRefresh).not.toHaveBeenCalled();
  }
});

it("switches whatever runs on Dev when Dev's sign-in is another login, with fresh nonces", async () => {
  for (const running of ["loaded", "busy"]) {
    const h = legacyHarness();
    h.dev.sessionHold = true;
    h.dev.active = true;
    if (running === "busy") h.dev.busy = ["Hourly heartbeat"];
    await expect(h.runtime.adopt("one")).resolves.toMatchObject({ status: "projecting" });
    await h.runtime.reconcile();
    expect(h.runtime.adoption("one")?.status).toBe("adopted");
    expect(h.legacyCalls("sessions")).toEqual([]);
    // Each delivery carries the Host login's fingerprints, which Dev checks inside the write.
    expect(h.deliveries[0]).toMatchObject({
      adoption: {
        sessionCheck: {
          nonce: expect.any(String),
          sid: expect.any(String),
          authTime: expect.any(String),
        },
      },
    });
    // Every comparison and delivery used its own nonce.
    expect(h.dev.nonces.length).toBeGreaterThan(1);
    expect(new Set(h.dev.nonces).size).toBe(h.dev.nonces.length);
    expect(h.journal()).not.toMatch(new RegExp(h.dev.nonces.join("|")));
  }
});

it("refuses while Dev runs a thread on what may be the Host's own sign-in, naming it only in the reply", async () => {
  // Not shown to be another login: Dev's token says so, or a claim is missing on either side.
  const session = (claims: { sid?: string; auth_time?: number }) =>
    idToken("owner@example.com", "person-1", claims);
  for (const [name, devToken, hostToken] of [
    ["same login, perhaps a stale copy", session(HOST_SESSION), null],
    [
      "same authentication time, other session ID",
      session({ ...HOST_SESSION, sid: "renewed" }),
      null,
    ],
    ["no session claims on Dev", session({}), null],
    ["no session claims on the Host", session({ sid: "dev", auth_time: 1 }), session({})],
  ] as const) {
    const h = legacyHarness();
    h.dev.sessionHold = true;
    h.dev.signedIn = devToken;
    if (hostToken) h.setGrant({ idToken: hostToken });
    h.dev.busy = ["Hourly heartbeat"];
    await expect(h.runtime.adopt("one"), name).rejects.toThrow('running: "Hourly heartbeat".');
  }
  const h = legacyHarness();
  h.dev.sessionHold = true;
  h.dev.signedIn = idToken("owner@example.com");
  h.dev.busy = ["Hourly heartbeat", "Fix the build", "Review", "Docs"];
  await expect(h.runtime.adopt("one")).rejects.toThrow(
    'Dev is using the same sign-in as the Host on this account, and a Dev thread is running: "Hourly heartbeat", "Fix the build", "Review" and 1 more. Try again when it has finished.',
  );
  expect(h.runtime.adoption("one")).toMatchObject({ status: "failed", error: SAME_GRANT_BUSY });
  expect(h.journal()).not.toContain("Hourly heartbeat");
  expect(h.deliveries).toEqual([]);
  // Loaded but idle: Dev decides inside the write, holding its sessions there.
  h.dev.busy = [];
  h.dev.active = true;
  await h.runtime.adopt("one");
  expect(h.deliveries[0]).toMatchObject({
    adoption: { sessionCheck: { nonce: expect.any(String) } },
  });
});

it("keeps an offline Dev pending, adopts one account at a time and never shares a home", async () => {
  const h = legacyHarness();
  h.dev.online = false;
  await expect(h.runtime.adopt("one")).resolves.toMatchObject({ status: "pinning" });
  await expect(h.runtime.adopt("two")).rejects.toThrow("Another Codex account is switching");
  h.dev.online = true;
  await h.runtime.reconcile();
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("adopted");
  // A second binding that resolves to the adopted directory is refused.
  h.dev.targets["codex-secondary"] = { ...h.dev.targets["codex-primary"]! };
  await expect(h.runtime.adopt("two")).resolves.toMatchObject({
    status: "failed",
    error: "Another account already uses this account's Dev folder. Nothing was changed.",
  });
  expect(h.deliveries.every((item) => item.providerId === "codex-primary")).toBe(true);
});

it("un-adopts without signing the Host out and lets an exclusion win mid-adoption", async () => {
  const h = legacyHarness();
  await adopted(h);
  await expect(h.runtime.unadopt("one")).resolves.toMatchObject({
    status: "unadopted",
    restored: { copyAgeMs: 5_000, mayNeedSignIn: true },
  });
  expect(h.deliveries.at(-1)).toMatchObject({ providerId: "codex-primary", access: null });
  expect(h.legacyCalls("restore")).toHaveLength(1);
  // The restore consumed this folder's copy, so retention no longer tracks it. With nothing
  // restored the copy may still be on Dev, and its entry stays for retention to delete.
  expect(h.runtime.adoption("one")?.copies).toEqual([]);
  const kept = legacyHarness();
  kept.dev.restoreFound = false;
  await adopted(kept);
  await kept.runtime.unadopt("one");
  expect(kept.runtime.adoption("one")?.copies).toEqual([
    {
      target: kept.dev.targets["codex-primary"],
      savedSince: expect.any(Number),
      person: expect.any(String),
    },
  ]);
  expect(h.cli.logout).not.toHaveBeenCalled();
  expect(h.settings.update).not.toHaveBeenCalled();
  const delivered = h.deliveries.length;
  await h.runtime.reconcile();
  expect(h.deliveries).toHaveLength(delivered);

  const excluded = legacyHarness();
  excluded.dev.refusal = "pending";
  await excluded.runtime.adopt("one");
  excluded.exclude("one");
  excluded.dev.refusal = null;
  await excluded.runtime.reconcile();
  await excluded.runtime.reconcile();
  expect(excluded.runtime.adoption("one")).toMatchObject({
    status: "failed",
    error: "This account was turned off for Dev while switching, so the switch was undone.",
  });
  expect(excluded.deliveries.at(-1)).toMatchObject({ access: null });
  expect(excluded.cli.logout).not.toHaveBeenCalled();
});

it("refuses a Host re-sign-in as another person until the owner confirms it", async () => {
  const h = legacyHarness();
  await adopted(h);
  expect(h.journal()).not.toContain("person-1");
  // The Host is signed in again, through the app or a shell, as someone else.
  const other = idToken("someone@example.com", "person-2");
  h.setGrant({
    idToken: other,
    accessToken: "synthetic-other-person",
    expiresAt: h.now() + 9 * DAY,
  });
  h.advance(10 * 60_000);
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "needs-owner-confirmation",
    error: IDENTITY_CHANGED,
  });
  expect(h.deliveries.some((item) => JSON.stringify(item).includes("synthetic-other-person"))).toBe(
    false,
  );
  // Only the owner's confirmation lets the new person through, after the idle and pin checks.
  const pins = h.legacyCalls("pin").length;
  const sessions = h.legacyCalls("sessions").length;
  await h.runtime.adopt("one");
  await h.runtime.reconcile();
  expect(h.legacyCalls("pin").length).toBe(pins + 1);
  expect(h.legacyCalls("sessions").length).toBe(sessions + 1);
  expect(h.runtime.adoption("one")?.status).toBe("adopted");
  expect(h.deliveries.at(-1)).toMatchObject({ access: { accessToken: "synthetic-other-person" } });
  // Confirming does not restart the 30-day cap on the copy saved at the first projection.
  expect(h.legacyCalls("forget-copy")).toEqual([]);
  h.advance(30 * DAY - 5 * 60_000);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy")).toHaveLength(1);
});

it("keeps the first backup's 30-day cap and the person check through a failed retry", async () => {
  const h = legacyHarness();
  await adopted(h);
  const firstTarget = h.dev.targets["codex-primary"];
  // The Host is signed in again as someone else; the owner confirms, but the Host sign-in
  // cannot renew, so the confirmation fails before Dev's home is pinned again.
  h.setGrant({ idToken: idToken("b@example.com", "person-2"), expiresAt: h.now() + 9 * DAY });
  h.advance(10 * 60_000);
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  h.setGrant({ hasRefreshToken: false });
  await h.runtime.adopt("one");
  expect(h.runtime.adoption("one")).toMatchObject({ status: "failed", target: null });
  // A different person again on the retry gets the different-person reason, not a generic one.
  h.setGrant({ hasRefreshToken: true, idToken: idToken("c@example.com", "person-3") });
  await h.runtime.adopt("one");
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "needs-owner-confirmation",
    error: IDENTITY_CHANGED,
  });
  // Confirming from that warning accepts this person explicitly, and the switch goes through.
  await h.runtime.adopt("one");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("adopted");
  // The backup saved at the first projection still goes 30 days after it, in its own folder.
  expect(h.legacyCalls("forget-copy")).toEqual([]);
  h.advance(30 * DAY - 5 * 60_000);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy")).toHaveLength(1);
  expect(h.legacyCalls("forget-copy")[0]!.body.target).toEqual(firstTarget);
  // The person Dev's home holds coming back is never called a different person.
  h.setGrant({ idToken: idToken("d@example.com", "person-4"), expiresAt: h.now() + 9 * DAY });
  h.advance(10 * 60_000);
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  h.setGrant({ idToken: idToken("c@example.com", "person-3") });
  await h.runtime.adopt("one");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("adopted");
});

it("deletes each folder's backup at its own cap after a re-switch into another folder", async () => {
  const h = legacyHarness();
  await adopted(h);
  // Dev's connection for the account moves to another folder, which has its own sign-in.
  h.dev.targets["codex-elsewhere"] = {
    realpath: "/home/paseo/codex-elsewhere",
    dev: "41",
    ino: "1003",
  };
  h.rebindDev("one", "codex-elsewhere");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("cancelled");
  h.advance(10 * DAY);
  h.setGrant({ expiresAt: h.now() + 40 * DAY });
  await h.runtime.adopt("one");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("adopted");
  // The first folder's copy goes 30 days after its first projection, the second's 30 after its.
  h.advance(20 * DAY);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy").map((item) => item.body.target)).toEqual([
    h.dev.targets["codex-primary"],
  ]);
  h.advance(10 * DAY);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy").map((item) => item.body.target)).toEqual([
    h.dev.targets["codex-primary"],
    h.dev.targets["codex-elsewhere"],
  ]);
});

it("stops delivering on a manual rebind or a changed Dev home", async () => {
  const h = legacyHarness();
  await adopted(h);
  h.rebindDev("one", "codex-elsewhere");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("cancelled");
  const delivered = h.deliveries.length;
  h.advance(10 * 60_000);
  await h.runtime.reconcile();
  expect(h.deliveries).toHaveLength(delivered);
  expect(h.legacyCalls("restore")).toEqual([]);

  // A first projection Dev refuses fails the adoption and stops delivering entirely.
  const refused = legacyHarness();
  refused.dev.refusal = "existing_sign_in";
  await refused.runtime.adopt("one");
  await refused.runtime.reconcile();
  expect(refused.runtime.adoption("one")?.status).toBe("failed");
  refused.dev.refusal = null;
  await refused.runtime.reconcile();
  const settled = refused.deliveries.length;
  // Once a refresh comes due, a refresher left running would fail on the retired policy.
  refused.setGrant({ expiresAt: refused.now() + 20 * 60_000 });
  refused.advance(10 * 60_000);
  await refused.runtime.reconcile();
  expect(refused.deliveries).toHaveLength(settled);
  const records = JSON.parse(
    readFileSync(join(refused.stateDir, "codex-signin", "state.json"), "utf8"),
  ) as Array<{ definitionId: string; signedIn: boolean; failureReason?: string }>;
  const record = records.find((item) => item.definitionId === "one");
  expect(record).toMatchObject({ signedIn: false });
  expect(record?.failureReason).toBeUndefined();
  expect(refused.cli.logout).not.toHaveBeenCalled();

  const moved = legacyHarness();
  await adopted(moved);
  moved.dev.refusal = "target_changed";
  await moved.runtime.reconcile();
  expect(moved.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  moved.dev.refusal = null;
  const before = moved.requests.length;
  await moved.runtime.reconcile();
  expect(moved.requests.slice(before)).toEqual([]);
});

const RESUME_WAIT = 5 * 60_000;

it("resumes an adoption paused for a changed folder only on a Dev that pins by path", async () => {
  const h = legacyHarness();
  await adopted(h);
  const sessions = h.legacyCalls("sessions").length;
  h.dev.refusal = "target_changed";
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "needs-owner-confirmation",
    parkedReason: "target_changed",
  });
  h.dev.refusal = null;
  // The folder's inode changed at the same path, as on Dev's virtiofs mount.
  h.dev.targets["codex-primary"] = { ...h.dev.targets["codex-primary"]!, ino: "2001" };
  // A Dev without codexLegacyPinByPath keeps the earlier rule: only the owner resumes it.
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  expect(h.legacyCalls("inspect")).toEqual([]);
  h.dev.pinByPath = true;
  h.advance(RESUME_WAIT);
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "adopted",
    error: null,
    target: h.dev.targets["codex-primary"],
  });
  // Dev had acknowledged the projection and the folder still holds it: no idle check.
  expect(h.legacyCalls("sessions")).toHaveLength(sessions);

  // A different person on the Host never resumes without the owner.
  h.setGrant({
    idToken: idToken("someone@example.com", "person-2"),
    accessToken: "synthetic-other-person",
    expiresAt: h.now() + 9 * DAY,
  });
  h.advance(10 * 60_000);
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "needs-owner-confirmation",
    error: IDENTITY_CHANGED,
  });
  const inspections = h.legacyCalls("inspect").length;
  h.advance(RESUME_WAIT);
  await h.runtime.reconcile();
  expect(h.legacyCalls("inspect")).toHaveLength(inspections);
  expect(h.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  expect(h.deliveries.some((item) => JSON.stringify(item).includes("synthetic-other-person"))).toBe(
    false,
  );
});

it("resumes a first projection Dev paused only once no Dev session uses the account", async () => {
  const h = legacyHarness();
  h.dev.pinByPath = true;
  h.dev.refusal = "target_changed";
  await expect(h.runtime.adopt("one")).resolves.toMatchObject({
    status: "needs-owner-confirmation",
    projectedAt: null,
    parkedFrom: "projecting",
  });
  h.dev.refusal = null;
  h.dev.active = true;
  const sessions = h.legacyCalls("sessions").length;
  await h.runtime.reconcile();
  expect(h.legacyCalls("sessions")).toHaveLength(sessions + 1);
  expect(h.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  h.dev.active = false;
  h.advance(RESUME_WAIT);
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("projecting");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("adopted");
});

it("reads a record the installed release parked, keeps its unknown field and leaves it parked", async () => {
  const h = legacyHarness();
  await adopted(h);
  // As the first adoption release stored a folder change: no reason, no person on the copy.
  const [record] = JSON.parse(h.journal()) as Array<Record<string, unknown>>;
  const copies = record!.copies as Array<Record<string, unknown>>;
  const installed = {
    ...record,
    status: "needs-owner-confirmation",
    error: "Dev's folder for this account changed. Confirm to try again.",
    copies: copies.map(({ person: _person, ...copy }) => copy),
    fromNewerRelease: { kept: true },
  };
  h.writeJournal([installed]);
  h.removeExtra();
  h.dev.pinByPath = true;
  await h.runtime.reconcile();
  // It cannot tell a paused undo from a paused adoption, so only the owner resumes it, and the
  // owner is offered both directions.
  expect(h.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  expect(h.legacyCalls("inspect")).toEqual([]);
  expect(JSON.parse(h.journal())[0]).toMatchObject({ fromNewerRelease: { kept: true } });
  expect(adoptionView(h.runtime.adoption("one")!)).toMatchObject({ directionUnknown: true });
  // Stopping withdraws the projection and puts Dev's saved sign-in back.
  await h.runtime.unadopt("one");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "unadopted",
    restored: { mayNeedSignIn: true },
  });
  expect(h.legacyCalls("restore")).toHaveLength(1);
  expect(h.deliveries.at(-1)).toMatchObject({ access: null });
});

it("continues a paused undo by itself and never turns it back into an adoption", async () => {
  const h = legacyHarness();
  await adopted(h);
  h.dev.refusal = "target_changed";
  await h.runtime.unadopt("one");
  expect(h.runtime.adoption("one")).toMatchObject({
    status: "needs-owner-confirmation",
    parkedReason: "target_changed",
    parkedFrom: "unadopting",
  });
  // The facts a rolled-back coordinator would refuse stay out of adoption.json.
  expect(h.installedJournal()[0]?.status).toBe("needs-owner-confirmation");
  expect(adoptionView(h.runtime.adoption("one")!).directionUnknown).toBeUndefined();
  // Confirming would reverse the owner's undo; the undo finishes by itself.
  await expect(h.runtime.adopt("one")).rejects.toThrow(STOPPING);
  h.dev.refusal = null;
  h.dev.pinByPath = true;
  await h.runtime.reconcile();
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")).toMatchObject({ status: "unadopted", restored: {} });
  expect(h.legacyCalls("restore")).toHaveLength(1);

  // Without the sidecar the paused status is unknown, so nothing resumes by itself.
  const lost = legacyHarness();
  await adopted(lost);
  lost.dev.refusal = "target_changed";
  await lost.runtime.unadopt("one");
  lost.removeExtra();
  lost.dev.refusal = null;
  lost.dev.pinByPath = true;
  await lost.runtime.reconcile();
  expect(lost.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  expect(lost.legacyCalls("inspect")).toEqual([]);
});

it("lets the owner confirm a settled folder change while Dev is busy, never another person", async () => {
  const h = legacyHarness();
  await adopted(h);
  const [record] = JSON.parse(h.journal()) as Array<Record<string, unknown>>;
  h.writeJournal([
    {
      ...record,
      status: "needs-owner-confirmation",
      error: "Dev's folder for this account changed. Confirm to try again.",
    },
  ]);
  h.removeExtra();
  h.dev.pinByPath = true;
  h.dev.active = true;
  // Dev sessions already run on the access-only copy, which has no refresh token to race.
  await h.runtime.adopt("one");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("adopted");

  const other = legacyHarness();
  await adopted(other);
  other.setGrant({
    idToken: idToken("someone@example.com", "person-2"),
    expiresAt: other.now() + 9 * DAY,
  });
  other.advance(10 * 60_000);
  await other.runtime.reconcile();
  expect(other.runtime.adoption("one")?.error).toBe(IDENTITY_CHANGED);
  other.dev.pinByPath = true;
  other.dev.active = true;
  await expect(other.runtime.adopt("one")).resolves.toMatchObject({
    status: "failed",
    error: ACTIVE_DEV_SESSION,
  });
});

it("keeps a record it cannot read, changes nothing for its account and still guards its folder", async () => {
  const h = legacyHarness();
  const unreadable = {
    definitionId: "one",
    status: "from-a-newer-release",
    target: { realpath: h.dev.targets["codex-primary"]!.realpath },
  };
  h.writeJournal([unreadable]);
  await expect(h.runtime.adopt("one")).rejects.toThrow(UNREADABLE_RECORD);
  await expect(h.runtime.unadopt("one")).rejects.toThrow(UNREADABLE_RECORD);
  expect(h.runtime.adoptions()[0]).toMatchObject({ reason: UNREADABLE_RECORD, record: null });
  await h.runtime.reconcile();
  h.dev.targets["codex-secondary"] = { ...h.dev.targets["codex-primary"]! };
  await expect(h.runtime.adopt("two")).resolves.toMatchObject({
    status: "failed",
    error: "Another account already uses this account's Dev folder. Nothing was changed.",
  });
  expect(JSON.parse(h.journal())).toContainEqual(unreadable);
  expect(h.deliveries).toEqual([]);

  // A record naming no folder could hold any folder, so it stops other accounts too.
  const pathless = legacyHarness();
  pathless.writeJournal([{ definitionId: "two", status: "from-a-newer-release" }]);
  await expect(pathless.runtime.adopt("one")).rejects.toThrow(OTHER_UNREADABLE_RECORD);

  // A file that cannot be parsed at all is never written over, and nothing starts.
  const broken = legacyHarness();
  broken.writeJournal([]);
  const file = join(broken.stateDir, "codex-signin", "adoption.json");
  writeFileSync(file, "not json");
  await expect(broken.runtime.adopt("one")).rejects.toThrow(UNREADABLE_RECORD);
  await expect(broken.runtime.adopt("two")).rejects.toThrow(UNREADABLE_RECORD);
  await expect(broken.runtime.unadopt("one")).rejects.toThrow(UNREADABLE_RECORD);
  await broken.runtime.reconcile();
  expect(readFileSync(file, "utf8")).toBe("not json");
});

it("refreshes under a Host lease, leaving a loaded session the last ten minutes", async () => {
  const h = legacyHarness();
  await adopted(h);
  // An idle loaded Host session does not block a refresh 20 minutes before expiry.
  h.dev.loaded = true;
  h.setGrant({ expiresAt: h.now() + 20 * 60_000 });
  h.advance(6 * 60_000);
  await h.runtime.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  // Startup ran before the lease, and the process ended before its release.
  expect(h.order).toEqual(["open", "acquire", "refresh", "close", "release"]);
  expect(h.refresh.mock.calls[0]![0]).toBe(25_000);
  // Within ten minutes of expiry the loaded session refreshes by itself.
  h.order.length = 0;
  h.setGrant({ expiresAt: h.now() + 8 * 60_000 });
  h.advance(61_000);
  await h.runtime.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.order.slice(0, 4)).toEqual(["open", "acquire", "close", "release"]);
  // A starting session or a running turn refuses the lease. Under six minutes are left by
  // now, so Codex is not even started.
  h.order.length = 0;
  h.dev.leaseGranted = false;
  h.dev.loaded = false;
  h.advance(61_000);
  await h.runtime.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.order).toContain("acquire");
  expect(h.order).not.toContain("open");
  expect(h.runtime.read("one").connection.refresh?.outcome).not.toBe("failed");
});

it("starts Codex only under the lease when six minutes or less remain", async () => {
  const h = legacyHarness();
  await adopted(h);
  // Any request to a starting Codex could refresh proactively now, so nothing starts unleased.
  h.setGrant({ expiresAt: h.now() + 5 * 60_000 });
  h.advance(61_000);
  await h.runtime.reconcile();
  expect(h.order).toEqual(["acquire", "open", "refresh", "close", "release"]);
  expect(h.cli.openRefresh).toHaveBeenLastCalledWith(expect.any(String), {
    startTimeoutMs: 25_000,
  });
  // With a loaded Host session, that session refreshes and the coordinator starts nothing.
  h.order.length = 0;
  h.dev.loaded = true;
  h.setGrant({ expiresAt: h.now() + 5 * 60_000 });
  h.advance(61_000);
  await h.runtime.reconcile();
  expect(h.order).toContain("release");
  expect(h.order).not.toContain("open");
  // Refused lease: nothing starts at all.
  h.order.length = 0;
  h.dev.loaded = false;
  h.dev.leaseGranted = false;
  h.advance(61_000);
  await h.runtime.reconcile();
  expect(h.order).toContain("acquire");
  expect(h.order).not.toContain("open");
  // A startup that outruns the lease is ended before the lease is released.
  h.order.length = 0;
  h.dev.leaseGranted = true;
  h.dev.startupMs = 40_000;
  h.advance(61_000);
  await h.runtime.reconcile();
  expect(h.order.slice(0, 4)).toEqual(["acquire", "open", "close", "release"]);
  expect(h.order).not.toContain("refresh");
  expect(h.runtime.read("one").connection.refresh?.outcome).not.toBe("failed");
});

it("never holds a lease through a slow startup and aborts a refresh that outruns it", async () => {
  const h = legacyHarness();
  await adopted(h);
  h.dev.startupMs = 40_000;
  h.dev.refreshOutcome = "timed-out";
  h.setGrant({ expiresAt: h.now() + 20 * 60_000 });
  h.advance(6 * 60_000);
  await h.runtime.reconcile();
  // The 40-second startup came before the lease, so the refresh still gets 25 seconds.
  expect(h.order.slice(0, 5)).toEqual(["open", "acquire", "refresh", "close", "release"]);
  expect(h.refresh.mock.calls[0]![0]).toBe(25_000);
  // Running out of lease is a skipped refresh, not a failure.
  expect(h.runtime.read("one").connection.refresh).toBeNull();
});

it("deletes the saved sign-in only when retention ends", async () => {
  // The owner's rule is the default: 7 days after proven, 30 days at most.
  const h = legacyHarness();
  await adopted(h);
  // Not proven: the 30-day cap decides.
  h.advance(29 * DAY);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy")).toEqual([]);
  h.advance(DAY);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy")).toHaveLength(1);

  // Proven: a Host refresh Dev acknowledged, then a clean Dev usage read, starts 7 days.
  const proven = legacyHarness();
  await adopted(proven);
  proven.setGrant({ accessToken: "synthetic-renewed", expiresAt: proven.now() + 20 * DAY });
  proven.advance(6 * 60_000);
  await proven.runtime.reconcile();
  proven.usage.fetchedAt = new Date(proven.now() + 1).toISOString();
  proven.advance(60_000);
  await proven.runtime.reconcile();
  expect(proven.runtime.adoption("one")?.provenAt).toBe(proven.now());
  proven.advance(7 * DAY - 1);
  await proven.runtime.reconcile();
  expect(proven.legacyCalls("forget-copy")).toEqual([]);
  proven.advance(1);
  await proven.runtime.reconcile();
  expect(proven.legacyCalls("forget-copy")).toHaveLength(1);

  const none = legacyHarness({ retention: { mode: "none", provenDays: 0, capDays: 0 } });
  await none.runtime.adopt("one");
  expect(none.deliveries[0]).toMatchObject({ adoption: { keepLocalSignIn: false } });
});

it("keeps retention and says plainly what un-adopt left after an adoption stopped", async () => {
  // A manual rebind cancels the adoption; the saved copy still goes at the 30-day cap.
  const h = legacyHarness();
  await adopted(h);
  h.rebindDev("one", "codex-elsewhere");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("cancelled");
  h.advance(30 * DAY);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy")).toHaveLength(1);
  expect(h.runtime.adoption("one")?.copyForgottenAt).toBe(h.now());
  // Un-adopting from there withdraws and restores nothing, and the record says so.
  await expect(h.runtime.unadopt("one")).resolves.toMatchObject({
    status: "unadopted",
    restored: null,
    restoreSkipped: true,
  });
  expect(h.legacyCalls("restore")).toEqual([]);

  // Waiting for the owner after a changed home: Dev offline delays retention, then it runs.
  const moved = legacyHarness();
  await adopted(moved);
  moved.dev.refusal = "target_changed";
  await moved.runtime.reconcile();
  moved.dev.refusal = null;
  expect(moved.runtime.adoption("one")?.status).toBe("needs-owner-confirmation");
  moved.dev.online = false;
  moved.advance(30 * DAY);
  await moved.runtime.reconcile();
  expect(moved.runtime.adoption("one")?.copyForgottenAt).toBeNull();
  const attempts = moved.legacyCalls("forget-copy").length;
  moved.dev.online = true;
  await moved.runtime.reconcile();
  // A failed attempt waits an hour rather than retrying every tick.
  expect(moved.legacyCalls("forget-copy")).toHaveLength(attempts);
  // Past the cap, a deletion that keeps failing is reported, not left silent.
  expect(moved.runtime.adoption("one")?.copyDeleteBlocked).toBe(
    "Dev could not be reached. It is tried again every hour.",
  );
  moved.advance(60 * 60_000);
  await moved.runtime.reconcile();
  expect(moved.legacyCalls("forget-copy")).toHaveLength(attempts + 1);
  expect(moved.runtime.adoption("one")).toMatchObject({
    copyForgottenAt: moved.now(),
    copyDeleteBlocked: null,
  });
});

it("keeps one backup clock per folder path, even after the folder is recreated", async () => {
  const h = legacyHarness();
  await adopted(h);
  const firstSaved = h.runtime.adoption("one")!.copies![0]!.savedSince;
  h.advance(10 * DAY);
  h.setGrant({ expiresAt: h.now() + 40 * DAY });
  // The folder is recreated at the same path with its backup copied across: a new inode, which
  // an older Dev refuses, and the owner confirms again.
  h.dev.targets["codex-primary"] = { ...h.dev.targets["codex-primary"]!, ino: "3001" };
  h.dev.refusal = "target_changed";
  await h.runtime.reconcile();
  h.dev.refusal = null;
  await h.runtime.adopt("one");
  await h.runtime.reconcile();
  expect(h.runtime.adoption("one")?.status).toBe("adopted");
  expect(h.runtime.adoption("one")?.copies).toEqual([
    expect.objectContaining({ savedSince: firstSaved, person: expect.any(String) }),
  ]);
  expect(h.installedJournal()[0]?.copies).toHaveLength(1);
  h.advance(20 * DAY);
  await h.runtime.reconcile();
  expect(h.legacyCalls("forget-copy")).toHaveLength(1);
  expect(h.runtime.adoption("one")?.copies).toEqual([]);

  // A ninth folder is refused rather than dropping an older backup's clock.
  const full = legacyHarness();
  await adopted(full);
  const [record] = JSON.parse(full.journal()) as Array<Record<string, unknown>>;
  const elsewhere = Array.from({ length: 8 }, (_, index) => ({
    target: { realpath: `/home/paseo/codex-old-${index}`, dev: "41", ino: String(4000 + index) },
    savedSince: full.now(),
  }));
  full.writeJournal([{ ...record, status: "unadopted", copies: elsewhere }]);
  await expect(full.runtime.adopt("one")).resolves.toMatchObject({
    status: "failed",
    error: TOO_MANY_FOLDERS,
  });
});

it("re-sends the projection while Host refreshes fail, without spending a retry", async () => {
  const h = legacyHarness();
  await adopted(h);
  h.refresh.mockRejectedValueOnce(new Error("synthetic refresh failure"));
  h.setGrant({ expiresAt: h.now() + 20 * 60_000 });
  h.advance(6 * 60_000);
  await h.runtime.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  // Within the retry wait, the next tick still re-sends the current projection to Dev.
  const delivered = h.deliveries.length;
  h.advance(30_000);
  await h.runtime.reconcile();
  expect(h.deliveries.length).toBeGreaterThan(delivered);
  expect(h.refresh).toHaveBeenCalledTimes(1);
});

it("starts adoption only from the owner's routes, never from Dev's", async () => {
  const h = legacyHarness();
  const app = express();
  app.use(express.json());
  mountCodexSignInRoutes(app, h.runtime);
  mountCodexSignInConsumer(app, {
    paseoHome: h.stateDir,
    store: {} as unknown as DaemonConfigStore,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      // No account ID, email, token, provider ID or Dev path reaches the app from adoption.
      if (/adopt/.test(route))
        expect(text).not.toMatch(/synthetic|owner@example|workspace-1|codex-|home\/paseo/);
      const json = response.headers.get("content-type")?.includes("json");
      return { status: response.status, body: json ? JSON.parse(text) : null };
    };
    // Dev's daemon routes still cannot start one.
    expect(
      (await post("/api/installation/codex/signin/adopt", { definitionId: "one" })).status,
    ).toBe(404);
    const forged = await post("/api/installation/codex/signin/legacy", {
      operation: "adopt",
      definitionId: "one",
    });
    expect(forged.status).toBe(400);
    expect(h.runtime.adoption("one")).toBeNull();

    const owner = "/api/installation/owner/codex/signin";
    expect((await post(`${owner}/adoptions`, {})).body).toEqual({
      definitions: [
        { definitionId: "one", eligible: true, reason: null, adoption: null },
        { definitionId: "two", eligible: true, reason: null, adoption: null },
      ],
    });
    h.dev.online = false;
    expect(await post(`${owner}/adopt`, { definitionId: "one" })).toMatchObject({
      status: 200,
      body: { adoption: { status: "pinning", error: null } },
    });
    // One at a time, with the plain reason.
    expect(await post(`${owner}/adopt`, { definitionId: "two" })).toEqual({
      status: 409,
      body: {
        error: "Another Codex account is switching to the Host's sign-in. Wait for it to finish.",
      },
    });
    h.dev.online = true;
    await h.runtime.reconcile();
    await h.runtime.reconcile();
    // The panel keeps reading an adopted account, and still does after the adoption ends.
    expect((await post(`${owner}/read`, { definitionId: "one" })).status).toBe(200);
    expect(await post(`${owner}/unadopt`, { definitionId: "one" })).toMatchObject({
      status: 200,
      body: { adoption: { status: "unadopted", restored: { mayNeedSignIn: true } } },
    });
    expect(h.cli.logout).not.toHaveBeenCalled();
    expect((await post(`${owner}/read`, { definitionId: "one" })).status).toBe(200);
    h.dev.active = true;
    expect(await post(`${owner}/adopt`, { definitionId: "two" })).toMatchObject({
      status: 409,
      body: {
        error: "A Dev session is using this account. Stop it, then try again.",
        adoption: { status: "failed" },
      },
    });
    expect((await post(`${owner}/read`, { definitionId: "two" })).status).toBe(200);
    // A failure a Host sign-in repairs is flagged, so the app can offer that sign-in beside it.
    h.dev.active = false;
    h.setGrant({ hasRefreshToken: false });
    const renew = await post(`${owner}/adopt`, { definitionId: "two" });
    expect(renew).toMatchObject({
      status: 409,
      body: { adoption: { status: "failed", hostSignInNeeded: true } },
    });
    expect(renew.body.error).toMatch(/Sign in on the Host, then try again\.$/);
    expect((await post(`${owner}/unadopt`, { definitionId: "missing" })).status).toBe(409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
