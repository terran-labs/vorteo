import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import type { ProviderLoginSession } from "../../../services/provider-login/session.js";
import { createClaudeOAuthRuntime } from "./claude-oauth-runtime.js";
import { writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  accessProjectionDigest,
  type ClaudeOAuthProjectionDelivery,
} from "./claude-oauth-delivery.js";
import type { ClaudeHostCli } from "./claude-oauth-host.js";
import { readClaudeOAuthGrant, type ClaudeOAuthGrant } from "./claude-oauth-storage.js";
import {
  claudeAuthorityDir,
  claudeAuthorityEnabledFile,
  fileCredentialStore,
  type ClaudeCredentialStore,
} from "./claude-oauth-authority.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const SUPPORTED = {
  installationSettingsAuthority: true,
  claudeFullSignIn: true,
  claudeSignInUpgrade: true,
};

interface HarnessOptions {
  /** Bind the definition in every environment, as a connected setup-token account is. */
  everywhere?: boolean;
  /** Coordinator refresh state present before the runtime starts. */
  state?: (definitionId: string) => unknown;
  setupSigningIn?: boolean;
  /** Other definitions in the installation, such as an account already on full sign-in. */
  others?: InstallationProvider[];
  /** Real plaintext CLI storage in throwaway directories, read with the real grant reader. */
  custody?: boolean;
  /** Opt the account into coordinator custody with its enable marker. */
  enabled?: boolean;
}

function harness(
  accountSetup?:
    | InstallationProvider["accountSetup"]
    | ((creationId: string) => InstallationProvider["accountSetup"]),
  devFeatures: {
    installationSettingsAuthority?: boolean;
    claudeFullSignIn?: boolean;
    claudeSignInUpgrade?: boolean;
  } = SUPPORTED,
  options: HarnessOptions = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), "claude-oauth-runtime-"));
  directories.push(stateDir);
  const creationId = randomUUID();
  const setup = typeof accountSetup === "function" ? accountSetup(creationId) : accountSetup;
  const providerId = `claude-account-${creationId}`;
  const installationId = randomUUID();
  const config = {
    stateDir,
    public: {
      installationId,
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
      providerType: "claude",
      ...(setup ? { accountSetup: setup } : {}),
      bindings: options.everywhere ? { host: providerId, dev: providerId } : { host: providerId },
      policy: { enabled: true, label: "Max" },
    },
    ...(options.others ?? []),
  ];
  const resourceExclusions: Record<string, { providerIds: string[] }> = {};
  const snapshot = () => ({
    revision,
    settings: { providerDefinitions: definitions, resourceExclusions },
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
  // A real directory: authority custody takes the CLI's storage lock inside it.
  const configDir = join(stateDir, "host", "claude-accounts", providerId);
  mkdirSync(configDir, { recursive: true });
  // Empty raw storage: these cases cover the account directory path before adoption.
  if (options.enabled) {
    const marker = claudeAuthorityEnabledFile(stateDir, "one");
    // The coordinator keeps its state directory private, as installation does.
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "");
  }
  const store: ClaudeCredentialStore = options.custody
    ? { ...fileCredentialStore }
    : {
        read: async () => null,
        write: async () => {},
        writeFile: async () => {},
        primaryHolds: async () => false,
        remove: async () => {},
      };
  const deliveries: ClaudeOAuthProjectionDelivery[] = [];
  const authorizations: string[] = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    authorizations.push(`${String(url)} ${headers.get("Authorization")}`);
    const body = JSON.parse(String(init?.body));
    if (
      String(url).endsWith("/api/installation/claude/oauth/binding") ||
      String(url).endsWith("/api/installation/claude/oauth/upgrade-binding")
    )
      return Response.json({ providerId: body.providerId, configDir });
    deliveries.push(body);
    const { access, ...slot } = body as ClaudeOAuthProjectionDelivery;
    return Response.json({
      ...slot,
      digest: accessProjectionDigest(access),
      phase: "applied",
      active: access !== null,
    });
  });
  let complete: ((success: boolean) => void) | null = null;
  const session: ProviderLoginSession = {
    scope: configDir,
    start: async (onComplete) => {
      complete = onComplete;
      return {
        verificationUrl: "https://claude.com/cai/oauth/authorize?state=synthetic",
        userCode: "",
        inputRequired: true,
      };
    },
    submitCode: async () => complete?.(true),
    readAccountLabel: async () => null,
    cancel: async () => {},
    dispose: async () => {},
  };
  const cli = {
    refresh: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    identity: vi.fn(async () => ({ email: "owner@example.com", orgId: "org-1" })),
    loginSession: vi.fn(async () => session),
  };
  const grant: ClaudeOAuthGrant = {
    accessToken: "synthetic-access-token",
    hasRefreshToken: true,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["user:inference", "user:profile"],
  };
  const readGrant = vi.fn(async (dir: string): Promise<ClaudeOAuthGrant | null> => {
    if (options.custody) return readClaudeOAuthGrant(dir, { platform: "linux" });
    return dir === configDir ? grant : null;
  });
  let clock = Date.now();
  const daemonFeatures = vi.fn(async (kind: "host" | "container") =>
    kind === "container" ? devFeatures : SUPPORTED,
  );
  if (options.state)
    writeClaudeSetupFile(join(stateDir, "claude-oauth", "state.json"), options.state("one"));
  const setupRuntime = {
    signingIn: vi.fn(() => options.setupSigningIn === true),
    reconcile: vi.fn(async () => {}),
  };
  const runtime = createClaudeOAuthRuntime(config, settings, undefined, {
    daemonFeatures,
    cli: cli as unknown as ClaudeHostCli,
    readGrant,
    store,
    fetch: fetchFake as unknown as typeof fetch,
    now: () => clock,
    setup: setupRuntime,
  });
  return {
    runtime,
    fetchFake,
    resourceExclusions,
    settings,
    setupRuntime,
    complete: (success: boolean) => complete?.(success),
    cli,
    readGrant,
    deliveries,
    authorizations,
    configDir,
    providerId,
    creationId,
    stateDir,
    store,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    definitions: () => definitions,
  };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

it("signs the Host account in, projects it to Dev and signs it out, storing no token", async () => {
  const h = harness();
  const started = await h.runtime.start("one");
  expect(h.definitions()[0]).toMatchObject({
    accountSetup: { provider: "claude", creationId: h.creationId, signIn: "full" },
    bindings: { host: h.providerId, dev: h.providerId },
  });
  expect(h.settings.reconcile).toHaveBeenCalled();
  await until(() => h.runtime.read("one").login.status === "waiting");
  expect(h.cli.loginSession).toHaveBeenCalledWith(h.configDir);
  const attemptId = "attemptId" in started ? started.attemptId : "";
  await h.runtime.submit("one", attemptId, "synthetic-code#synthetic-state");
  await until(() => h.deliveries.length === 1);
  expect(h.cli.identity).toHaveBeenCalledWith(h.configDir);
  expect(h.readGrant).toHaveBeenCalledWith(h.configDir);
  expect(h.deliveries[0]).toMatchObject({
    serverId: "dev",
    providerId: h.providerId,
    generation: 1,
    rotation: 1,
    access: { accessToken: "synthetic-access-token" },
  });
  expect(h.authorizations).toContain(
    "http://127.0.0.1:2/api/installation/claude/oauth/projection Bearer synthetic-dev-password",
  );
  expect(h.authorizations[0]).toBe(
    "http://127.0.0.1:1/api/installation/claude/oauth/binding Bearer synthetic-host-password",
  );
  await until(() => h.runtime.read("one").connection.environments[0]?.status === "ready");
  expect(h.runtime.read("one").connection).toMatchObject({
    signedIn: true,
    identity: { email: "owner@example.com", orgId: "org-1" },
  });
  const state = readFileSync(join(h.stateDir, "claude-oauth", "state.json"), "utf8");
  expect(state).not.toContain("synthetic-access-token");

  await expect(h.runtime.signOut("one")).resolves.toBeNull();
  expect(h.cli.logout).toHaveBeenCalledWith(h.configDir);
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 2, rotation: 0, access: null });
  expect(h.runtime.read("one").connection).toMatchObject({
    signedIn: false,
    environments: [{ serverId: "dev", status: "disconnected" }],
  });
});

it("reports a failed Host sign-out but still withdraws Dev", async () => {
  const h = harness();
  await h.runtime.start("one");
  h.cli.logout.mockRejectedValueOnce(new Error("CLI unavailable"));
  await expect(h.runtime.signOut("one")).resolves.toContain("did not finish on the Host");
  expect(h.deliveries.at(-1)).toMatchObject({ access: null });
});

it("refuses to turn a setup-token account into a full sign-in account", async () => {
  const h = harness({ provider: "claude", creationId: randomUUID() });
  await expect(h.runtime.start("one")).rejects.toThrow();
  expect(h.settings.update).not.toHaveBeenCalled();
  expect(h.cli.loginSession).not.toHaveBeenCalled();
});

it("refuses to mark a definition full sign-in until every daemon advertises support", async () => {
  // An older Dev daemon would reject the whole settings authority because of the new field.
  const h = harness(undefined, { installationSettingsAuthority: true });
  await expect(h.runtime.start("one")).rejects.toThrow();
  expect(h.settings.update).not.toHaveBeenCalled();
  expect(h.definitions()[0]?.accountSetup).toBeUndefined();
  expect(h.cli.loginSession).not.toHaveBeenCalled();
});

const setupToken = (creationId: string) => ({ provider: "claude" as const, creationId });

it("upgrades a setup-token account in place after a verified Host sign-in", async () => {
  const h = harness(setupToken, SUPPORTED, { everywhere: true });
  const original = structuredClone(h.definitions()[0]);
  await expect(h.runtime.upgradeRead("one")).resolves.toEqual({
    available: true,
    login: { status: "idle" },
  });
  const started = await h.runtime.upgradeStart("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  expect(h.authorizations[0]).toBe(
    "http://127.0.0.1:1/api/installation/claude/oauth/upgrade-binding Bearer synthetic-host-password",
  );
  expect(h.cli.loginSession).toHaveBeenCalledWith(h.configDir);
  // Nothing changes while the sign-in is pending.
  expect(h.definitions()[0]).toEqual(original);
  expect(h.settings.update).not.toHaveBeenCalled();
  const attemptId = "attemptId" in started ? started.attemptId : "";
  await h.runtime.submit("one", attemptId, "synthetic-code#synthetic-state");
  await until(() => h.runtime.read("one").login.status === "succeeded");
  expect(h.definitions()[0]).toEqual({
    ...original,
    accountSetup: { provider: "claude", creationId: h.creationId, signIn: "full" },
  });
  expect(h.settings.update).toHaveBeenCalledTimes(1);
  expect(h.settings.update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }));
  expect(h.cli.logout).not.toHaveBeenCalled();
  await until(() => h.setupRuntime.reconcile.mock.calls.length > 0);
  await until(() => h.deliveries.length === 1);
  expect(h.deliveries[0]).toMatchObject({ serverId: "dev", providerId: h.providerId });
  expect(h.runtime.read("one").connection).toMatchObject({
    signedIn: true,
    identity: { email: "owner@example.com", orgId: "org-1" },
  });
  await expect(h.runtime.upgradeRead("one")).resolves.toMatchObject({
    available: false,
    login: { status: "succeeded", attemptId },
  });
});

it("leaves the setup-token account unchanged when the upgrade is cancelled or fails", async () => {
  const h = harness(setupToken, SUPPORTED, { everywhere: true });
  const original = structuredClone(h.definitions()[0]);
  const first = await h.runtime.upgradeStart("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  const firstId = "attemptId" in first ? first.attemptId : "";
  await expect(h.runtime.cancel("one", firstId)).resolves.toMatchObject({ status: "cancelled" });

  await h.runtime.upgradeStart("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  h.complete(false);
  await until(() => h.runtime.read("one").login.status === "failed");

  expect(h.definitions()[0]).toEqual(original);
  expect(h.settings.update).not.toHaveBeenCalled();
  expect(h.setupRuntime.reconcile).not.toHaveBeenCalled();
  expect(h.cli.logout).not.toHaveBeenCalled();
  expect(h.deliveries).toEqual([]);
  await expect(h.runtime.upgradeRead("one")).resolves.toMatchObject({ available: true });
});

it("refuses a sign-in to a different account than the one recorded and signs it out", async () => {
  const h = harness(setupToken, SUPPORTED, {
    everywhere: true,
    state: (definitionId) => [
      {
        definitionId,
        generation: 1,
        rotation: 0,
        signedIn: false,
        hostGrant: null,
        policyRevision: 1,
        digest: null,
        expiresAt: null,
        identity: { email: "Owner@Example.com", orgId: "org-1" },
        checkedAt: null,
        refresh: null,
        targets: [],
      },
    ],
  });
  const original = structuredClone(h.definitions()[0]);
  h.cli.identity.mockResolvedValueOnce({ email: "someone@example.com", orgId: "org-2" });
  await h.runtime.upgradeStart("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  h.complete(true);
  await until(() => h.runtime.read("one").login.status === "failed");
  expect(h.runtime.read("one").login).toMatchObject({
    message: expect.stringContaining("belongs to Owner@Example.com"),
  });
  expect(h.cli.logout).toHaveBeenCalledWith(h.configDir);
  expect(h.definitions()[0]).toEqual(original);
  expect(h.settings.update).not.toHaveBeenCalled();
});

it("refuses a first upgrade into a Claude login another account already uses", async () => {
  const otherCreation = randomUUID();
  const h = harness(setupToken, SUPPORTED, {
    everywhere: true,
    others: [
      {
        id: "two",
        providerType: "claude",
        accountSetup: { provider: "claude", creationId: otherCreation, signIn: "full" },
        bindings: { host: `claude-account-${otherCreation}` },
        policy: { enabled: true, label: "Claude 2" },
      },
    ],
    state: () => [
      {
        definitionId: "two",
        generation: 1,
        rotation: 0,
        signedIn: true,
        hostGrant: "present",
        policyRevision: 1,
        digest: null,
        expiresAt: null,
        identity: { email: "Shared@Example.com", orgId: "org-1" },
        checkedAt: null,
        refresh: null,
        targets: [],
      },
    ],
  });
  const original = structuredClone(h.definitions()[0]);
  h.cli.identity.mockResolvedValueOnce({ email: "shared@example.com", orgId: "org-1" });
  await h.runtime.upgradeStart("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  h.complete(true);
  await until(() => h.runtime.read("one").login.status === "failed");
  expect(h.runtime.read("one").login).toMatchObject({
    message: expect.stringContaining("Claude 2 already uses"),
  });
  expect(h.cli.logout).toHaveBeenCalledWith(h.configDir);
  expect(h.definitions()[0]).toEqual(original);
  expect(h.settings.update).not.toHaveBeenCalled();
});

it("signs the new grant out when the definition changed during the upgrade", async () => {
  const h = harness(setupToken, SUPPORTED, { everywhere: true });
  const original = structuredClone(h.definitions()[0]);
  vi.mocked(h.settings.update).mockRejectedValueOnce(new Error("Settings revision is stale"));
  await h.runtime.upgradeStart("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  h.complete(true);
  await until(() => h.runtime.read("one").login.status === "failed");
  expect(h.cli.logout).toHaveBeenCalledWith(h.configDir);
  expect(h.definitions()[0]).toEqual(original);
  await expect(h.runtime.upgradeRead("one")).resolves.toMatchObject({ available: true });
});

it("accepts the recorded account regardless of email case", async () => {
  const h = harness(setupToken, SUPPORTED, {
    everywhere: true,
    state: (definitionId) => [
      {
        definitionId,
        generation: 1,
        rotation: 0,
        signedIn: false,
        hostGrant: null,
        policyRevision: 1,
        digest: null,
        expiresAt: null,
        identity: { email: "OWNER@example.com", orgId: null },
        checkedAt: null,
        refresh: null,
        targets: [],
      },
    ],
  });
  await h.runtime.upgradeStart("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  h.complete(true);
  await until(() => h.runtime.read("one").login.status === "succeeded");
  expect(h.definitions()[0]?.accountSetup?.signIn).toBe("full");
});

it("offers and starts an upgrade only when every daemon advertises support", async () => {
  const h = harness(
    setupToken,
    { installationSettingsAuthority: true, claudeFullSignIn: true },
    {
      everywhere: true,
    },
  );
  await expect(h.runtime.upgradeRead("one")).resolves.toEqual({
    available: false,
    login: { status: "idle" },
  });
  await expect(h.runtime.upgradeStart("one")).rejects.toThrow();
  expect(h.cli.loginSession).not.toHaveBeenCalled();
  expect(h.settings.update).not.toHaveBeenCalled();
});

it("does not upgrade while a setup-token sign-in runs or for a full sign-in account", async () => {
  const busy = harness(setupToken, SUPPORTED, { everywhere: true, setupSigningIn: true });
  await expect(busy.runtime.upgradeStart("one")).rejects.toThrow();
  expect(busy.cli.loginSession).not.toHaveBeenCalled();
  const full = harness(
    (creationId) => ({ provider: "claude", creationId, signIn: "full" }),
    SUPPORTED,
    {
      everywhere: true,
    },
  );
  await expect(full.runtime.upgradeRead("one")).resolves.toMatchObject({ available: false });
  await expect(full.runtime.upgradeStart("one")).rejects.toThrow();
});

it.each(["missing", "unreadable", "expired", "not renewable"] as const)(
  "preserves the setup token when upgrade grant storage is %s despite identity metadata",
  async (failure) => {
    const h = harness(setupToken, SUPPORTED, { everywhere: true });
    const original = structuredClone(h.definitions()[0]);
    if (failure === "unreadable") h.readGrant.mockRejectedValue(new Error("Storage unavailable"));
    else if (failure === "missing") h.readGrant.mockResolvedValue(null);
    else
      h.readGrant.mockResolvedValue({
        accessToken: "synthetic-access",
        hasRefreshToken: failure !== "not renewable",
        expiresAt: failure === "expired" ? 1 : Date.now() + 3_600_000,
        scopes: ["user:inference"],
      });
    await h.runtime.upgradeStart("one");
    await until(() => h.runtime.read("one").login.status === "waiting");
    h.complete(true);
    await until(() => h.runtime.read("one").login.status === "failed");
    expect(h.definitions()[0]).toEqual(original);
    expect(h.settings.update).not.toHaveBeenCalled();
    expect(h.setupRuntime.reconcile).not.toHaveBeenCalled();
    expect(h.cli.logout).not.toHaveBeenCalled();
    expect(h.readGrant).toHaveBeenCalledWith(h.configDir);
  },
);

it("recovers only the current enabled binding in the authenticated environment", async () => {
  const h = harness(
    (creationId) => ({ provider: "claude", creationId, signIn: "full" }),
    SUPPORTED,
    {
      everywhere: true,
      state: (definitionId) => [
        {
          definitionId,
          generation: 1,
          rotation: 0,
          signedIn: true,
          hostGrant: null,
          policyRevision: 1,
          digest: null,
          expiresAt: null,
          identity: null,
          checkedAt: null,
          refresh: null,
          targets: [],
        },
      ],
    },
  );
  const input = { providerId: h.providerId, configDir: h.configDir };
  await expect(
    h.runtime.recover("host", { ...input, configDir: "/another-account" }),
  ).rejects.toThrow();
  await expect(
    h.runtime.recover("container", { ...input, providerId: "another-account" }),
  ).rejects.toThrow();
  h.resourceExclusions.host = { providerIds: ["one"] };
  await expect(h.runtime.recover("host", input)).rejects.toThrow();
  delete h.resourceExclusions.host;
  h.definitions()[0]!.policy.enabled = false;
  await expect(h.runtime.recover("host", input)).rejects.toThrow();
  h.definitions()[0]!.policy.enabled = true;
  h.fetchFake.mockImplementationOnce(async () => {
    await h.settings.update({
      expectedRevision: 1,
      settings: { providerDefinitions: h.definitions() },
    });
    return Response.json(input);
  });
  await expect(h.runtime.recover("host", input)).rejects.toThrow();
  expect(h.cli.refresh).not.toHaveBeenCalled();
  expect(h.readGrant).not.toHaveBeenCalled();
  await h.runtime.recover("host", input);
  expect(h.readGrant).toHaveBeenCalledWith(h.configDir);
  expect(h.authorizations).toContain(
    "http://127.0.0.1:1/api/installation/claude/oauth/binding Bearer synthetic-host-password",
  );
  await h.runtime.signOut("one");
  await expect(h.runtime.recover("host", input)).rejects.toThrow();
});

async function signedInAt(options: HarnessOptions) {
  const h = harness(undefined, SUPPORTED, { custody: true, everywhere: true, ...options });
  const login = (n: number) => ({
    claudeAiOauth: {
      accessToken: `synthetic-access-${n}`,
      refreshToken: `synthetic-refresh-${n}`,
      expiresAt: h.now() + 8 * 3_600_000,
      scopes: ["user:inference"],
    },
  });
  // The official CLI refreshes in whichever directory it is launched with.
  h.cli.refresh.mockImplementation(async (dir: string) => {
    if ((await fileCredentialStore.read(dir))?.claudeAiOauth)
      await fileCredentialStore.write(dir, login(2));
  });
  // The sign-in the official CLI saved into the account directory.
  await fileCredentialStore.write(h.configDir, login(1));
  const started = await h.runtime.start("one");
  await until(() => h.runtime.read("one").login.status === "waiting");
  const attemptId = "attemptId" in started ? started.attemptId : "";
  await h.runtime.submit("one", attemptId, "synthetic-code#synthetic-state");
  await until(() => h.deliveries.length === 1);
  const agentFile = () => readFileSync(join(h.configDir, ".credentials.json"), "utf8");
  const authority = claudeAuthorityDir(h.stateDir, "one");
  const intoLeadWindow = () => h.advance(8 * 3_600_000 - 3 * 60_000);
  return { h, agentFile, authority, intoLeadWindow };
}

it("refreshes only in the coordinator's authority and keeps Host agents access-only", async () => {
  const { h, agentFile, authority, intoLeadWindow } = await signedInAt({ enabled: true });
  expect(agentFile()).toContain("synthetic-access-1");
  expect(agentFile()).not.toContain("synthetic-refresh");
  expect((await fileCredentialStore.read(authority))?.claudeAiOauth).toMatchObject({
    refreshToken: "synthetic-refresh-1",
  });

  // Inside the lead window, concurrent triggers produce one refresh, in the authority only.
  intoLeadWindow();
  await Promise.all([h.runtime.reconcile(), h.runtime.reconcile()]);
  expect(h.cli.refresh).toHaveBeenCalledTimes(1);
  expect(h.cli.refresh).toHaveBeenCalledWith(authority);
  expect(agentFile()).toContain("synthetic-access-2");
  expect(agentFile()).not.toContain("synthetic-refresh");
  expect(h.deliveries.at(-1)).toMatchObject({ access: { accessToken: "synthetic-access-2" } });
});

it("without the account's enable marker keeps the previous in-directory refresh", async () => {
  const { h, agentFile, authority, intoLeadWindow } = await signedInAt({});
  expect(agentFile()).toContain("synthetic-refresh-1");
  intoLeadWindow();
  await h.runtime.reconcile();
  expect(h.cli.refresh).toHaveBeenCalledWith(h.configDir);
  expect(agentFile()).toContain("synthetic-refresh-2");
  expect(await fileCredentialStore.read(authority)).toBeNull();
});

it("keeps renewing in the authority when the Host access copy cannot be written", async () => {
  const { h, authority, intoLeadWindow } = await signedInAt({ enabled: true });
  h.store.writeFile = async () => {
    throw new Error("account directory unwritable");
  };
  intoLeadWindow();
  await h.runtime.reconcile();
  expect(h.cli.refresh).toHaveBeenCalledWith(authority);
  expect(h.deliveries.at(-1)).toMatchObject({ access: { accessToken: "synthetic-access-2" } });
});
