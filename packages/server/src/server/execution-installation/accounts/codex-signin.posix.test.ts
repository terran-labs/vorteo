import express from "express";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { createRequireBearerMiddleware, hashDaemonPassword } from "../../auth.js";
import { readInstallationSettings } from "../settings/projection.js";
import type { InstallationSettingsAdmission } from "../settings/admission.js";
import { createCodexAccount } from "../../../services/provider-login/create-account.js";
import { mountCodexSignInConsumer } from "./codex-signin-consumer.js";
import { codexProjectionDigest } from "./codex-signin-delivery.js";
import { CodexRefreshLeases } from "./codex-signin-lease.js";
import { codexSessionCheck, codexSignInKeyDigest } from "./codex-signin-identity.js";

const PASSWORD = "synthetic-password";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function temporary(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
/** Unsigned synthetic ID token naming a person, the way Codex's auth claims do. */
const personToken = (person: string) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { "https://api.openai.com/auth": { chatgpt_user_id: person } };
  return `${encode({ alg: "none" })}.${encode(claims)}.synthetic`;
};
const ID_TOKEN = personToken("person-1");
/** The Host sign-in's login session claims, top-level in its ID token. */
const HOST_SESSION = { sid: "host-session", auth_time: 1_700_000_000 };
const sessionToken = (session: { sid?: string; auth_time?: number }) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = {
    sub: "person-1",
    ...session,
    "https://api.openai.com/auth": { chatgpt_user_id: "person-1" },
  };
  return `${encode({ alg: "none" })}.${encode(claims)}.synthetic`;
};
const HOST_TOKEN = sessionToken(HOST_SESSION);
const access = (accessToken: string, accountId: string | null = "workspace-1") => ({
  accessToken,
  idToken: ID_TOKEN,
  accountId,
  expiresAt: 2_000_000_000_000,
  lastRefresh: "2026-10-20T00:00:00.000Z",
});

async function fixture(serverId = "dev") {
  const paseoHome = await temporary("codex-signin-consumer-");
  const creationId = randomUUID();
  const providerId = `codex-account-${creationId}`;
  const binding = {
    installationId: randomUUID(),
    serverId,
    environment: serverId === "dev" ? ("container" as const) : ("host" as const),
    revision: 1,
  };
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const settings = readInstallationSettings(initial);
  const authority = (excluded: boolean): InstallationSettingsAdmission => ({
    ...binding,
    installationInstructions: "",
    settings: {
      ...settings,
      providerDefinitions: [
        {
          id: "one",
          providerType: "codex",
          accountSetup: { provider: "codex", creationId },
          bindings: { [serverId]: providerId },
          policy: { enabled: true, label: "ChatGPT Pro" },
        },
      ],
      resourceExclusions: excluded
        ? {
            [serverId]: { providerIds: ["one"], terminalProfileIds: [], metadataProviderIds: [] },
          }
        : {},
    },
  });
  let current = authority(false);
  const store = new DaemonConfigStore(paseoHome, initial, undefined, {
    installationSettingsReader: { read: async () => current },
  });
  const app = express();
  app.use(createRequireBearerMiddleware({ password: await hashDaemonPassword(PASSWORD) }));
  app.use(express.json());
  mountCodexSignInConsumer(app, {
    paseoHome,
    store,
    codexRefreshLeases: new CodexRefreshLeases({ activity: () => "none" }),
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PASSWORD}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const scope = {
    installationId: binding.installationId,
    serverId,
    definitionId: "one",
    providerId,
    policyRevision: 1,
  };
  const home = join(paseoHome, "codex-accounts", providerId);
  const authFile = join(home, "auth.json");
  return {
    paseoHome,
    store,
    creationId,
    providerId,
    home,
    authFile,
    scope,
    post,
    readAuth: () => JSON.parse(readFileSync(authFile, "utf8")),
    exclude: (excluded: boolean) => {
      current = authority(excluded);
    },
    project: (generation: number, rotation: number, value: unknown) =>
      post("/api/installation/codex/signin/projection", {
        ...scope,
        generation,
        rotation,
        access: value,
      }),
  };
}

/** A sign-in made directly in this environment, before the installation connection. */
async function signInLocally(
  f: Awaited<ReturnType<typeof fixture>>,
  accountId: string,
  idToken = ID_TOKEN,
) {
  await createCodexAccount({
    paseoHome: f.paseoHome,
    store: f.store,
    creationId: f.creationId,
    name: "ChatGPT Pro",
  });
  mkdirSync(f.home, { recursive: true, mode: 0o700 });
  const local = {
    tokens: {
      id_token: idToken,
      access_token: "local-access",
      refresh_token: "local-refresh",
      account_id: accountId,
    },
    last_refresh: "2026-10-01T00:00:00Z",
  };
  writeFileSync(f.authFile, JSON.stringify(local), { mode: 0o600 });
  return local;
}

it("writes access-only Codex sign-ins in order, with an empty refresh token", async () => {
  const f = await fixture();
  const first = await f.project(1, 1, access("synthetic-access-a"));
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ phase: "applied", active: true, generation: 1, rotation: 1 });
  expect(first.body.digest).toBe(codexProjectionDigest(access("synthetic-access-a")));
  expect(f.readAuth()).toEqual({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: ID_TOKEN,
      access_token: "synthetic-access-a",
      refresh_token: "",
      account_id: "workspace-1",
    },
    last_refresh: "2026-10-20T00:00:00.000Z",
  });
  expect(statSync(f.authFile).mode & 0o777).toBe(0o600);
  expect(f.store.get().providers[f.providerId]?.env?.CODEX_HOME).toBe(f.home);
  // Older and conflicting slots are refused; a newer rotation replaces the token.
  expect((await f.project(1, 0, access("synthetic-old"))).status).toBe(409);
  expect((await f.project(1, 1, access("synthetic-other"))).status).toBe(409);
  expect((await f.project(1, 2, access("synthetic-access-b"))).status).toBe(200);
  expect(f.readAuth().tokens.access_token).toBe("synthetic-access-b");
  // A refresh token never reaches Dev: the strict schema rejects the payload.
  const withRefresh = { ...access("synthetic-access-c"), refreshToken: "synthetic-refresh" };
  expect((await f.project(1, 3, withRefresh)).status).toBe(400);
  expect(readFileSync(f.authFile, "utf8")).not.toContain("synthetic-refresh");
  const journal = readFileSync(join(f.home, ".vorteo-signin", "projection.json"), "utf8");
  expect(journal).not.toContain("synthetic-access");
});

it("refuses access for an excluded binding, applies its withdrawal and ignores stale grants", async () => {
  const f = await fixture();
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(200);
  f.exclude(true);
  expect((await f.project(1, 2, access("synthetic-next"))).status).toBe(409);
  const withdrawn = await f.project(1, 2, null);
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.body).toMatchObject({ phase: "applied", active: false });
  expect(existsSync(f.authFile)).toBe(false);
  // A late copy of the earlier sign-in cannot restore the credential.
  f.exclude(false);
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(409);
  expect(existsSync(f.authFile)).toBe(false);
});

it("replaces an earlier local sign-in of the same account and keeps a rollback copy", async () => {
  const f = await fixture();
  const local = await signInLocally(f, "workspace-1");
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(200);
  expect(f.readAuth().tokens).toMatchObject({
    access_token: "synthetic-access",
    refresh_token: "",
  });
  const copy = join(f.home, ".vorteo-signin", "local-sign-in.json");
  expect(JSON.parse(readFileSync(copy, "utf8"))).toEqual(local);
  expect(statSync(copy).mode & 0o777).toBe(0o600);
});

it("refuses to replace a local sign-in of a different or unverifiable account", async () => {
  const f = await fixture();
  const local = await signInLocally(f, "workspace-other");
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(409);
  expect((await f.project(1, 1, access("synthetic-access", null))).status).toBe(409);
  expect(f.readAuth()).toEqual(local);
  // Another person in the same Team workspace, or a sign-in that names no person, is refused.
  for (const idToken of [personToken("person-2"), "opaque-id-token"]) {
    const other = await signInLocally(f, "workspace-1", idToken);
    expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(409);
    expect(f.readAuth()).toEqual(other);
  }
  await signInLocally(f, "workspace-other");
  // A withdrawal never removes a sign-in made in this environment.
  expect((await f.project(1, 2, null)).status).toBe(200);
  expect(f.readAuth()).toEqual(local);
});

it("returns only the Host binding's exact CODEX_HOME, never a credential", async () => {
  const f = await fixture("host");
  const route = "/api/installation/codex/signin/binding";
  expect((await f.post(route, f.scope)).status).toBe(409);
  await createCodexAccount({
    paseoHome: f.paseoHome,
    store: f.store,
    creationId: f.creationId,
    name: "ChatGPT Pro",
  });
  const response = await f.post(route, f.scope);
  expect(response).toEqual({
    status: 200,
    body: { providerId: f.providerId, codexHome: f.home },
  });
  expect((await f.post(route, { ...f.scope, providerId: "codex-account-other" })).status).toBe(409);
  expect((await f.post(route, { ...f.scope, policyRevision: 2 })).status).toBe(409);
});

const ACCOUNT_1 = randomUUID();
const ACCOUNT_2 = randomUUID();
const LEGACY_ID = `account/${ACCOUNT_1}`;

/** A legacy Dev binding with its own CODEX_HOME, as before the installation managed Codex. */
async function legacyFixture(
  options: {
    otherHome?: (home: string) => string;
    /** The Dev daemon's own environment, which providers without CODEX_HOME inherit. */
    daemonEnv?: (home: string) => NodeJS.ProcessEnv;
    /** Providers that inherit a CODEX_HOME through `extends` instead of setting their own. */
    inheriting?: Record<string, string>;
  } = {},
) {
  const root = realpathSync(await temporary("codex-legacy-"));
  const paseoHome = join(root, "paseo");
  const home = join(root, "codex-primary");
  const homeB = join(root, "codex-secondary");
  mkdirSync(paseoHome, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(homeB, { mode: 0o700 });
  const binding = {
    installationId: randomUUID(),
    serverId: "dev",
    environment: "container" as const,
    revision: 1,
  };
  const provider = (label: string, codexHome: string, accountId: string) => ({
    extends: "codex",
    label,
    installationAccountId: accountId,
    env: { CODEX_HOME: codexHome },
  });
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: {
      "codex-primary": provider("Codex 1", home, ACCOUNT_1),
      "codex-secondary": provider(
        "Codex 2",
        options.otherHome ? options.otherHome(home) : homeB,
        ACCOUNT_2,
      ),
      ...Object.fromEntries(
        Object.entries(options.inheriting ?? {}).map(([id, parent]) => [
          id,
          { extends: parent, label: id },
        ]),
      ),
    },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const settings = readInstallationSettings(initial);
  let excluded = false;
  const definition = (id: string, accountId: string, devId: string) => ({
    id,
    providerType: "codex",
    accountId,
    bindings: { dev: devId, host: `codex-account-${randomUUID()}` },
    policy: { enabled: true, label: id },
  });
  const read = async (): Promise<InstallationSettingsAdmission> => ({
    ...binding,
    installationInstructions: "",
    settings: {
      ...settings,
      providerDefinitions: [
        definition(LEGACY_ID, ACCOUNT_1, "codex-primary"),
        definition(`account/${ACCOUNT_2}`, ACCOUNT_2, "codex-secondary"),
      ],
      resourceExclusions: excluded
        ? { dev: { providerIds: [LEGACY_ID], terminalProfileIds: [], metadataProviderIds: [] } }
        : {},
    },
  });
  const store = new DaemonConfigStore(paseoHome, initial, undefined, {
    installationSettingsReader: { read },
  });
  const inUse = new Set<string>();
  const titles = new Map<string, string[]>();
  const app = express();
  app.use(createRequireBearerMiddleware({ password: await hashDaemonPassword(PASSWORD) }));
  app.use(express.json());
  mountCodexSignInConsumer(app, {
    paseoHome,
    store,
    providerInUse: (id) => inUse.has(id),
    providerSessionActivity: (id) => (inUse.has(id) ? "busy" : "none"),
    providerBusyTitles: (id) => titles.get(id) ?? [],
    // Codex's default home lies outside the fixture unless a case puts it on the adopted home.
    daemonEnv: options.daemonEnv?.(home) ?? { HOME: join(root, "daemon-home") },
    codexRefreshLeases: new CodexRefreshLeases({
      activity: (id) => (inUse.has(id) ? "busy" : "none"),
    }),
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PASSWORD}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const scope = (providerId = "codex-primary", definitionId = LEGACY_ID) => ({
    installationId: binding.installationId,
    serverId: "dev",
    definitionId,
    providerId,
    policyRevision: 1,
  });
  const legacy = (operation: string, extra: Record<string, unknown> = {}, at = scope()) =>
    post("/api/installation/codex/signin/legacy", { ...at, operation, ...extra });
  const authFile = join(home, "auth.json");
  return {
    root,
    home,
    homeB,
    store,
    inUse,
    titles,
    authFile,
    scope,
    legacy,
    exclude: () => {
      excluded = true;
    },
    pin: async (at = scope()) => (await legacy("pin", {}, at)).body?.target,
    project: (
      target: unknown,
      slot: { generation: number; rotation: number },
      value: unknown,
      keepLocalSignIn = true,
      at = scope(),
      extra: Record<string, unknown> = {},
    ) =>
      post("/api/installation/codex/signin/projection", {
        ...at,
        ...slot,
        access: value,
        adoption: { target, keepLocalSignIn, ...extra },
      }),
    write: (value: unknown) => writeFileSync(authFile, JSON.stringify(value), { mode: 0o600 }),
    readAuth: () => readFileSync(authFile, "utf8"),
    copy: () => join(home, ".vorteo-signin", "local-sign-in.json"),
  };
}

const localSignIn = (
  accountId: string,
  refreshToken = "synthetic-local-refresh",
  idToken = ID_TOKEN,
) => ({
  tokens: {
    id_token: idToken,
    access_token: "local-access",
    refresh_token: refreshToken,
    account_id: accountId,
  },
  last_refresh: "2026-10-01T00:00:00Z",
});

it("pins an adopted legacy home only through real, unshared directories", async () => {
  const f = await legacyFixture();
  const target = await f.pin();
  expect(target).toEqual({
    realpath: f.home,
    dev: String(statSync(f.home, { bigint: true }).dev),
    ino: String(statSync(f.home, { bigint: true }).ino),
  });
  // A path through a symbolic link is refused, even when it leads to the same directory.
  symlinkSync(f.root, join(f.root, "link"));
  f.store.replaceProviderEnv("codex-primary", {
    CODEX_HOME: join(f.root, "link", "codex-primary"),
  });
  expect((await f.legacy("pin")).status).toBe(409);
  // Two bindings that resolve to one directory are refused.
  const shared = await legacyFixture({ otherHome: (home) => home });
  expect((await shared.legacy("pin")).status).toBe(409);
  // The built-in provider and any provider without its own CODEX_HOME use the daemon's
  // CODEX_HOME, or ~/.codex: when that is the adopted home, it is shared too.
  for (const daemonEnv of [
    (home: string) => ({ CODEX_HOME: home }),
    (home: string) => ({ HOME: join(home, ".."), CODEX_HOME: "" }),
  ]) {
    const implicit = await legacyFixture({ daemonEnv });
    if (!daemonEnv(implicit.home).CODEX_HOME)
      renameSync(implicit.home, join(implicit.root, ".codex"));
    const adopted = daemonEnv(implicit.home).CODEX_HOME
      ? implicit.home
      : join(implicit.root, ".codex");
    implicit.store.replaceProviderEnv("codex-primary", { CODEX_HOME: adopted });
    expect((await implicit.legacy("pin")).status).toBe(409);
  }
  // Excluded on Dev: nothing is pinned.
  const excluded = await legacyFixture();
  excluded.exclude();
  expect((await excluded.legacy("pin")).status).toBe(409);
});

it("reports whether a Dev session uses the legacy binding", async () => {
  const f = await legacyFixture();
  expect((await f.legacy("sessions")).body).toEqual({ active: false });
  f.inUse.add("codex-primary");
  expect((await f.legacy("sessions")).body).toEqual({ active: true });
  // A session on a provider that inherits the adopted home through `extends` uses it too.
  const inherited = await legacyFixture({ inheriting: { "codex-alias": "codex-primary" } });
  expect((await inherited.legacy("sessions")).body).toEqual({ active: false });
  inherited.inUse.add("codex-alias");
  expect((await inherited.legacy("sessions")).body).toEqual({ active: true });
  // So does one on the built-in provider when the daemon's CODEX_HOME is the adopted home.
  const builtIn = await legacyFixture({ daemonEnv: (home) => ({ CODEX_HOME: home }) });
  builtIn.inUse.add("codex");
  expect((await builtIn.legacy("sessions")).body).toEqual({ active: true });
});

it("replaces only a same-account sign-in or its own projection in a legacy home", async () => {
  const f = await legacyFixture();
  const target = await f.pin();
  const local = localSignIn("workspace-1");
  f.write(local);
  const first = await f.project(target, { generation: 1, rotation: 1 }, access("synthetic-a"));
  expect(first).toMatchObject({ status: 200, body: { phase: "applied", active: true } });
  expect(first.body.replacedLocally).toBeUndefined();
  expect(JSON.parse(f.readAuth()).tokens).toMatchObject({
    access_token: "synthetic-a",
    refresh_token: "",
  });
  expect(JSON.parse(readFileSync(f.copy(), "utf8"))).toEqual(local);
  // Its own projection is replaced by the next one.
  const second = await f.project(target, { generation: 1, rotation: 2 }, access("synthetic-b"));
  expect(second.status).toBe(200);
  expect(second.body.replacedLocally).toBeUndefined();
  // Dev Codex refreshed and saved its own grant after the projection: the next reconcile
  // writes the projection back and says so. The newer Dev sign-in becomes the saved copy.
  const refreshed = localSignIn("workspace-1", "synthetic-dev-rotated");
  f.write(refreshed);
  const repaired = await f.project(target, { generation: 1, rotation: 2 }, access("synthetic-b"));
  expect(repaired).toMatchObject({ status: 200, body: { replacedLocally: true } });
  expect(JSON.parse(f.readAuth()).tokens.access_token).toBe("synthetic-b");
  expect(JSON.parse(readFileSync(f.copy(), "utf8"))).toEqual(refreshed);
  // Anything it cannot attribute stays exactly as it is.
  const foreignProjection = {
    auth_mode: "chatgpt",
    tokens: { id_token: "x", access_token: "other", refresh_token: "", account_id: "workspace-1" },
  };
  for (const unknown of [
    localSignIn("workspace-other"),
    // Same Team workspace, another person: the workspace ID alone would have matched.
    localSignIn("workspace-1", "synthetic-local-refresh", personToken("person-2")),
    { OPENAI_API_KEY: "synthetic-api-key", tokens: null },
    foreignProjection,
  ]) {
    f.write(unknown);
    const before = f.readAuth();
    const refused = await f.project(target, { generation: 1, rotation: 3 }, access("synthetic-c"));
    expect(refused).toEqual({
      status: 409,
      body: { error: "Codex sign-in synchronization is pending.", reason: "existing_sign_in" },
    });
    expect(f.readAuth()).toBe(before);
  }
});

it("knows a legacy home by its path and refuses another account's or a shared one", async () => {
  const f = await legacyFixture();
  const target = await f.pin();
  // The inode changes at the same path, as on Dev's virtiofs mount: delivery continues.
  const drifted = { ...target, ino: String(BigInt(target.ino) + 1n) };
  const first = await f.project(drifted, { generation: 1, rotation: 1 }, access("synthetic-a"));
  expect(first.status).toBe(200);
  expect((await f.legacy("inspect")).body).toEqual({ target, signIn: "projection" });
  // Another adopted account's folder moved to this path holds a projection written for that
  // account: it is not replaced, apart from its own delivery journal refusing the scope.
  const r = await legacyFixture();
  const second = r.scope("codex-secondary", `account/${ACCOUNT_2}`);
  const targetB = await r.pin(second);
  const slot = { generation: 1, rotation: 1 };
  expect((await r.project(targetB, slot, access("synthetic-b"), true, second)).status).toBe(200);
  renameSync(r.home, `${r.home}-moved`);
  renameSync(r.homeB, r.home);
  rmSync(join(r.home, ".vorteo-signin", "projection.json"));
  const renamed = { realpath: r.home };
  const foreign = await r.project(renamed, slot, access("synthetic-a"));
  expect(foreign).toMatchObject({ status: 409, body: { reason: "existing_sign_in" } });
  expect(JSON.parse(r.readAuth()).tokens.access_token).toBe("synthetic-b");
  // Unless it holds a sign-in of the same person, as any home may.
  r.write(localSignIn("workspace-1"));
  expect((await r.project(renamed, slot, access("synthetic-a"))).status).toBe(200);
  // Substitution: another account's binding is redirected to the adopted home.
  const g = await legacyFixture();
  const pinned = await g.pin();
  g.store.replaceProviderEnv("codex-secondary", { CODEX_HOME: g.home });
  const substituted = await g.project(pinned, { generation: 1, rotation: 1 }, access("synthetic"));
  expect(substituted).toMatchObject({ status: 409, body: { reason: "target_changed" } });
  expect(existsSync(g.authFile)).toBe(false);
});

it("withdraws only its projection, restores the saved sign-in untested and honours retention", async () => {
  const f = await legacyFixture();
  const target = await f.pin();
  const local = localSignIn("workspace-1");
  f.write(local);
  expect(
    (await f.project(target, { generation: 1, rotation: 1 }, access("synthetic"))).status,
  ).toBe(200);
  expect((await f.project(target, { generation: 2, rotation: 0 }, null)).status).toBe(200);
  expect(existsSync(f.authFile)).toBe(false);
  const restored = await f.legacy("restore", { target });
  expect(restored).toMatchObject({ status: 200, body: { restored: true } });
  expect(restored.body.copyAgeMs).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(f.readAuth())).toEqual(local);
  expect(statSync(f.authFile).mode & 0o777).toBe(0o600);
  expect(existsSync(f.copy())).toBe(false);
  // A later adoption keeps the copy until retention deletes it; then un-adopt finds nothing.
  expect(
    (await f.project(target, { generation: 3, rotation: 1 }, access("synthetic"))).status,
  ).toBe(200);
  expect(existsSync(f.copy())).toBe(true);
  expect((await f.legacy("forget-copy", { target })).body).toEqual({ forgotten: true });
  expect(existsSync(f.copy())).toBe(false);
  expect((await f.project(target, { generation: 4, rotation: 0 }, null)).status).toBe(200);
  expect((await f.legacy("restore", { target })).body).toEqual({ restored: false });
  // A saved sign-in is put back only for a person the coordinator names.
  f.write(local);
  expect(
    (await f.project(target, { generation: 4, rotation: 1 }, access("synthetic"))).status,
  ).toBe(200);
  expect((await f.project(target, { generation: 4, rotation: 2 }, null)).status).toBe(200);
  const someoneElse = codexSignInKeyDigest("workspace-1", personToken("person-2"))!;
  expect((await f.legacy("restore", { target, persons: [someoneElse] })).status).toBe(409);
  expect(existsSync(f.authFile)).toBe(false);
  const owner = codexSignInKeyDigest("workspace-1", ID_TOKEN)!;
  expect((await f.legacy("restore", { target, persons: [owner] })).body).toMatchObject({
    restored: true,
  });
  rmSync(f.authFile);
  // With retention `none`, nothing is saved at all.
  f.write(local);
  expect(
    (await f.project(target, { generation: 5, rotation: 1 }, access("synthetic"), false)).status,
  ).toBe(200);
  expect(existsSync(f.copy())).toBe(false);

  // Retention still finds the copy by the pinned directory after the binding moved away.
  f.write(local);
  expect(
    (await f.project(target, { generation: 6, rotation: 1 }, access("synthetic"))).status,
  ).toBe(200);
  expect(existsSync(f.copy())).toBe(true);
  f.store.replaceProviderEnv("codex-primary", { CODEX_HOME: f.homeB });
  // Found by its real path even after the folder's inode drifted, so the entry never sticks.
  const drifted = { ...target, ino: String(BigInt(target.ino) + 1n) };
  expect((await f.legacy("forget-copy", { target: drifted })).body).toEqual({ forgotten: true });
  expect(existsSync(f.copy())).toBe(false);
  // A state folder that is a symbolic link refuses, and nothing it points at is deleted.
  const elsewhere = join(f.root, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  writeFileSync(join(elsewhere, "local-sign-in.json"), "{}", { mode: 0o600 });
  rmSync(join(f.home, ".vorteo-signin"), { recursive: true });
  symlinkSync(elsewhere, join(f.home, ".vorteo-signin"));
  expect((await f.legacy("forget-copy", { target })).status).toBe(409);
  expect(existsSync(join(elsewhere, "local-sign-in.json"))).toBe(true);
  // A folder whose state another account now owns holds that account's copy: left alone.
  const g = await legacyFixture();
  const second = g.scope("codex-secondary", `account/${ACCOUNT_2}`);
  writeFileSync(join(g.homeB, "auth.json"), JSON.stringify(local), { mode: 0o600 });
  const targetB = await g.pin(second);
  const slot = { generation: 1, rotation: 1 };
  expect((await g.project(targetB, slot, access("synthetic"), true, second)).status).toBe(200);
  const copyB = join(g.homeB, ".vorteo-signin", "local-sign-in.json");
  expect(existsSync(copyB)).toBe(true);
  expect((await g.legacy("forget-copy", { target: targetB })).body).toEqual({ forgotten: true });
  expect(existsSync(copyB)).toBe(true);
  expect((await g.legacy("forget-copy", { target: targetB }, second)).body).toEqual({
    forgotten: true,
  });
  expect(existsSync(copyB)).toBe(false);
});

it("checks Dev's login session inside the write, names busy threads plainly and holds them", async () => {
  const f = await legacyFixture();
  const target = await f.pin();
  const check = () => codexSessionCheck(HOST_TOKEN)!;
  const sessionCheck = async (value = check()) =>
    (await f.legacy("session-check", { sessionCheck: value })).body;
  // No refresh sign-in on Dev: nothing there can renew the Host's grant.
  expect(await sessionCheck()).toMatchObject({ different: true, active: false });

  // A copy of the Host's login, with busy threads' titles plain and capped: three, then more.
  f.write(localSignIn("workspace-1", "synthetic-dev-stale", HOST_TOKEN));
  f.inUse.add("codex-primary");
  f.titles.set("codex-primary", ["Line\nbreak\u0007 title", "x".repeat(200), "", "four", "five"]);
  expect(await sessionCheck()).toEqual({
    different: false,
    active: true,
    titles: ["Line break title", "x".repeat(80), "Untitled thread"],
    more: 2,
  });

  // While a thread runs, only a sign-in shown to be another login is replaced.
  let rotation = 0;
  const project = (sessionCheckValue?: unknown) =>
    f.project(
      target,
      { generation: 1, rotation: ++rotation },
      access(`synthetic-${rotation}`),
      true,
      undefined,
      sessionCheckValue ? { sessionCheck: sessionCheckValue } : {},
    );
  for (const [name, token, held] of [
    ["stale copy: same login, another refresh token", HOST_TOKEN, true],
    [
      "same authentication time, other session ID",
      sessionToken({ ...HOST_SESSION, sid: "renewed" }),
      true,
    ],
    ["no session ID or authentication time", ID_TOKEN, true],
    ["another login", sessionToken({ sid: "dev-session", auth_time: 1 }), false],
  ] as const) {
    f.write(localSignIn("workspace-1", "synthetic-dev-stale", token));
    expect((await project(check())).status, name).toBe(held ? 409 : 200);
  }
  // Its own projection is replaced with no check and no hold.
  expect((await project()).status).toBe(200);
  // Without the Host's fingerprints, another login is held too.
  f.write(
    localSignIn("workspace-1", "synthetic-dev-other", sessionToken({ sid: "d", auth_time: 1 })),
  );
  expect((await project()).status).toBe(409);
  expect(JSON.parse(f.readAuth()).tokens.refresh_token).toBe("synthetic-dev-other");
  // Once nothing runs the hold is granted, so none was left behind.
  f.inUse.delete("codex-primary");
  expect((await project()).status).toBe(200);
});

it("leases a Host account unless a session starts or runs a turn on it, for at most 30 s", async () => {
  const f = await fixture("host");
  await createCodexAccount({
    paseoHome: f.paseoHome,
    store: f.store,
    creationId: f.creationId,
    name: "ChatGPT Pro",
  });
  const lease = (operation: string, extra: Record<string, unknown> = {}) =>
    f.post("/api/installation/codex/signin/lease", { ...f.scope, operation, ...extra });
  const granted = await lease("acquire");
  expect(granted.body).toMatchObject({ granted: true, loaded: false });
  expect((await lease("acquire")).body).toEqual({ granted: false });
  await lease("release", { leaseId: granted.body.leaseId });
  expect((await lease("acquire")).body).toMatchObject({ granted: true });

  vi.useFakeTimers();
  try {
    const activity: Record<string, "busy" | "loaded"> = {
      "codex-busy": "busy",
      "codex-loaded": "loaded",
    };
    const leases = new CodexRefreshLeases({ activity: (id) => activity[id] ?? "none" });
    // A session starting or running a turn: no lease, so the coordinator does not refresh.
    expect(leases.acquire("codex-busy")).toBeNull();
    // An idle loaded session does not block; the coordinator learns it is there.
    expect(leases.acquire("codex-loaded")).toMatchObject({ loaded: true });
    expect(leases.hold("codex-idle")).toBeUndefined();
    // All or none: one busy provider leaves none of the others held.
    expect(leases.acquireAll(["codex-other", "codex-busy"])).toBeNull();
    const both = leases.acquireAll(["codex-other", "codex-third"]);
    expect(both).not.toBeNull();
    both!();
    expect(leases.hold("codex-other")).toBeUndefined();
    expect(leases.acquire("codex-idle")).not.toBeNull();
    // A session start waits for the lease, and never past its 30-second bound.
    let started = false;
    const held = leases.hold("codex-idle")!;
    void (async () => {
      await held;
      started = true;
    })();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
    expect(leases.hold("codex-idle")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
