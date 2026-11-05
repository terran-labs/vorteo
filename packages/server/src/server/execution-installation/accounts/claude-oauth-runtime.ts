import pino from "pino";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import {
  CLAUDE_START_FAILURE,
  ProviderLoginRefusal,
  ProviderLoginService,
} from "../../../services/provider-login/service.js";
import { requireEnvironmentDaemon, type InstallationConfig } from "../config.js";
import { connectInstallationDaemon, createInstallationRegistrationAdmission } from "../daemon.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  ClaudeOAuthBindingResponseSchema,
  ClaudeOAuthDeliveryError,
  ClaudeOAuthProjectionReceiptSchema,
  type ClaudeOAuthProjectionDelivery,
} from "./claude-oauth-delivery.js";
import { createClaudeHostCli, type ClaudeHostCli } from "./claude-oauth-host.js";
import { readClaudeOAuthGrant } from "./claude-oauth-storage.js";
import { ClaudeOAuthRefresher, type ClaudeOAuthPolicy } from "./claude-oauth-refresher.js";

// Sign-in start failures surface a short message in the interface; the cause goes to the log.
const logger = pino({ name: "vorteo-installation" });

interface DaemonFeatures {
  installationSettingsAuthority?: boolean;
  claudeFullSignIn?: boolean;
  claudeSignInUpgrade?: boolean;
}

/** How long an upgrade availability answer is reused before the daemons are asked again. */
const UPGRADE_SUPPORT_TTL_MS = 60_000;

function isActive(
  state: ProviderLoginState,
): state is Extract<ProviderLoginState, { status: "starting" | "waiting" | "verifying" }> {
  return state.status === "starting" || state.status === "waiting" || state.status === "verifying";
}

/** A setup-token account being upgraded in place: its Host directory and binding. */
interface PendingUpgrade {
  providerId: string;
  configDir: string;
}

interface RuntimeOverrides {
  /** Features each daemon advertises. Injected by tests. */
  daemonFeatures?: (kind: "host" | "container") => Promise<DaemonFeatures | undefined>;
  cli?: ClaudeHostCli;
  readGrant?: typeof readClaudeOAuthGrant;
  fetch?: typeof fetch;
  now?: () => number;
  /** The setup-token side of the same accounts, so the two sign-ins never overlap. */
  setup?: { signingIn(definitionId: string): boolean; reconcile(): Promise<void> };
}

/**
 * Owner-only coordinator service for full sign-in Claude accounts with Host-owned refresh.
 * Created only when the installation config sets `claudeHostRefresh: true`. It stores no token:
 * the Host account's own CLI storage holds the grant, and Dev receives access-only projections.
 */
export function createClaudeOAuthRuntime(
  config: InstallationConfig,
  settings: InstallationSettingsService,
  assertRegistrationReadiness?: (target: "host" | "container-daemon") => void,
  overrides: RuntimeOverrides = {},
) {
  const assertReady = createInstallationRegistrationAdmission(config, assertRegistrationReadiness);
  const configuration = structuredClone(config);
  const file = join(config.stateDir, "claude-oauth", "state.json");
  const cli = overrides.cli ?? createClaudeHostCli();
  const readGrant = overrides.readGrant ?? readClaudeOAuthGrant;
  const request = overrides.fetch ?? fetch;
  const now = overrides.now ?? Date.now;
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!host) throw new ClaudeOAuthDeliveryError();
  const daemonFeatures =
    overrides.daemonFeatures ??
    (async (kind: "host" | "container") => {
      const client = await connectInstallationDaemon(config, kind);
      try {
        return client.getLastServerInfoMessage()?.features;
      } finally {
        await client.close();
      }
    });

  /**
   * Older daemons parse definitions with a strict schema and would reject the whole settings
   * authority, not just this account, if it carried `signIn`. Check every daemon first.
   */
  async function assertFullSignInSupported() {
    for (const environment of config.public.environments) {
      assertReady(environment.kind === "host" ? "host" : "container-daemon");
      const features = await daemonFeatures(environment.kind);
      if (features?.installationSettingsAuthority !== true || features.claudeFullSignIn !== true)
        throw new ClaudeOAuthDeliveryError();
    }
  }

  function definition(definitionId: string) {
    const snapshot = settings.snapshot();
    const selected = snapshot.settings?.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    if (!selected || selected.providerType !== "claude" || snapshot.conflicts)
      throw new ClaudeOAuthDeliveryError();
    return { snapshot, selected };
  }
  function fullDefinition(definitionId: string) {
    const found = definition(definitionId);
    if (found.selected.accountSetup?.signIn !== "full") throw new ClaudeOAuthDeliveryError();
    return found;
  }
  function policy(definitionId: string): ClaudeOAuthPolicy {
    const { snapshot, selected } = fullDefinition(definitionId);
    const removed = selected.removed === true;
    return {
      revision: snapshot.revision,
      removed,
      targets: config.public.environments
        .filter((environment) => environment.kind === "container")
        .filter((environment) => Object.hasOwn(selected.bindings, environment.serverId))
        .map((environment) => ({
          serverId: environment.serverId,
          providerId: selected.bindings[environment.serverId]!,
          excluded:
            removed ||
            selected.policy.enabled === false ||
            Boolean(
              snapshot.settings?.resourceExclusions[environment.serverId]?.providerIds?.includes(
                selected.id,
              ),
            ),
        })),
    };
  }

  async function post(target: "host" | "container", route: string, body: unknown) {
    if (!isDeepStrictEqual(config, configuration)) throw new ClaudeOAuthDeliveryError();
    const daemon = requireEnvironmentDaemon(config, target);
    // Explicit loopback endpoints are validated by installation config, never supplied by clients.
    const response = await request(`http://${daemon.endpoint}${route}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${daemon.password}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new ClaudeOAuthDeliveryError();
    return response.json();
  }

  /** The Host binding's exact CLAUDE_CONFIG_DIR, cached per policy revision. */
  const directories = new Map<string, { revision: number; configDir: string }>();
  async function hostConfigDir(definitionId: string): Promise<string> {
    const { snapshot, selected } = fullDefinition(definitionId);
    const cached = directories.get(definitionId);
    if (cached?.revision === snapshot.revision) return cached.configDir;
    const providerId = selected.bindings[host!.serverId];
    if (!providerId) throw new ClaudeOAuthDeliveryError();
    assertReady("host");
    const binding = ClaudeOAuthBindingResponseSchema.parse(
      await post("host", "/api/installation/claude/oauth/binding", {
        installationId: config.public.installationId,
        serverId: host!.serverId,
        definitionId,
        providerId,
        policyRevision: snapshot.revision,
      }),
    );
    if (binding.providerId !== providerId) throw new ClaudeOAuthDeliveryError();
    directories.set(definitionId, { revision: snapshot.revision, configDir: binding.configDir });
    return binding.configDir;
  }

  const refresher = new ClaudeOAuthRefresher({
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(file) ?? [],
    persist: (state) => writeClaudeSetupFile(file, state),
    policy,
    grant: async (definitionId) => readGrant(await hostConfigDir(definitionId)),
    refresh: async (definitionId) => cli.refresh(await hostConfigDir(definitionId)),
    deliver: async (delivery: ClaudeOAuthProjectionDelivery) => {
      const environment = config.public.environments.find(
        (item) => item.serverId === delivery.serverId,
      );
      if (environment?.kind !== "container") throw new ClaudeOAuthDeliveryError();
      // Withdrawal remains available while ordinary Dev work is fenced.
      if (delivery.access !== null) assertReady("container-daemon");
      return ClaudeOAuthProjectionReceiptSchema.parse(
        await post("container", "/api/installation/claude/oauth/projection", delivery),
      );
    },
    now,
  });

  const upgrades = new Map<string, PendingUpgrade>();
  /** The attempt that started each upgrade, so upgrade status never reports an ordinary sign-in. */
  const upgradeAttempts = new Map<string, string>();
  const upgraded = new Set<string>();

  const login = new ProviderLoginService({
    startFailureMessage: () => CLAUDE_START_FAILURE,
    logger,
    getClient: (definitionId) => ({
      openAccountLoginSession: async () => {
        const upgrade = upgrades.get(definitionId);
        if (upgrade) {
          upgradeCandidate(definitionId);
          return cli.loginSession(upgrade.configDir);
        }
        const { selected } = fullDefinition(definitionId);
        if (selected.removed) throw new ClaudeOAuthDeliveryError();
        return cli.loginSession(await hostConfigDir(definitionId));
      },
    }),
    verify: async (definitionId) => {
      const upgrade = upgrades.get(definitionId);
      if (upgrade) await finishUpgrade(definitionId, upgrade);
    },
    onConnected: (definitionId) => {
      // An upgrade already recorded its identity while verifying.
      if (upgraded.delete(definitionId)) return;
      void (async () => {
        const identity = await cli.identity(await hostConfigDir(definitionId));
        await refresher.connected(definitionId, identity);
        await refresher.reconcile();
      })().catch(() => {});
    },
  });

  /**
   * A setup-token account that can move to full sign-in in place: managed, not removed, bound to
   * its deterministic provider ID in every environment.
   */
  function upgradeCandidate(definitionId: string) {
    const { snapshot, selected } = definition(definitionId);
    const setup = selected.accountSetup;
    if (selected.removed || selected.accountId || setup?.provider !== "claude" || setup.signIn)
      throw new ClaudeOAuthDeliveryError();
    const providerId = `claude-account-${setup.creationId}`;
    const complete = config.public.environments.every(
      (environment) => selected.bindings[environment.serverId] === providerId,
    );
    if (!complete || Object.values(selected.bindings).some((id) => id !== providerId))
      throw new ClaudeOAuthDeliveryError();
    return { snapshot, providerId, creationId: setup.creationId };
  }

  /** Every daemon must apply the switch, accept the token withdrawal and report the Host path. */
  async function assertUpgradeSupported() {
    for (const environment of config.public.environments) {
      assertReady(environment.kind === "host" ? "host" : "container-daemon");
      const features = await daemonFeatures(environment.kind);
      if (
        features?.installationSettingsAuthority !== true ||
        features.claudeFullSignIn !== true ||
        features.claudeSignInUpgrade !== true
      )
        throw new ClaudeOAuthDeliveryError();
    }
  }
  let upgradeSupport: { checkedAt: number; supported: boolean } | null = null;
  async function upgradeSupported(): Promise<boolean> {
    const checkedAt = now();
    if (upgradeSupport && checkedAt - upgradeSupport.checkedAt < UPGRADE_SUPPORT_TTL_MS)
      return upgradeSupport.supported;
    const supported = await assertUpgradeSupported().then(
      () => true,
      () => false,
    );
    upgradeSupport = { checkedAt, supported };
    return supported;
  }

  /** The label of another Claude definition whose recorded sign-in is this email, if any. */
  function duplicateIdentity(
    definitionId: string,
    email: string | null,
    snapshot: ReturnType<typeof definition>["snapshot"],
  ): string | null {
    if (!email) return null;
    for (const other of snapshot.settings?.providerDefinitions ?? []) {
      if (other.id === definitionId || other.removed || other.providerType !== "claude") continue;
      const recorded = refresher.status(other.id).identity?.email;
      if (recorded?.toLowerCase() === email.toLowerCase()) return other.policy.label ?? other.id;
    }
    return null;
  }

  /**
   * Verify persisted access before retiring the setup token. Later validation failures may
   * sign out a verified grant; unreadable storage must never trigger destructive cleanup.
   */
  async function finishUpgrade(definitionId: string, upgrade: PendingUpgrade) {
    let verifiedGrant = false;
    try {
      // Display metadata can survive a failed login. Verify persisted, renewable access before
      // retiring the setup token, and never log out storage we could not reliably read.
      const grant = await readGrant(upgrade.configDir);
      if (
        !grant?.accessToken ||
        !grant.hasRefreshToken ||
        grant.expiresAt === null ||
        grant.expiresAt <= now()
      )
        throw new ProviderLoginRefusal(
          "Claude did not save a usable sign-in. Your setup token is unchanged. Try the upgrade again.",
        );
      verifiedGrant = true;
      const identity = await cli.identity(upgrade.configDir);
      if (!identity)
        throw new ProviderLoginRefusal(
          "Claude did not report a signed-in account. Nothing changed. Start the upgrade again.",
        );
      // A setup token has no verifiable identity; one recorded by an earlier full sign-in binds.
      const recorded = refresher.status(definitionId).identity?.email ?? null;
      if (recorded && identity.email?.toLowerCase() !== recorded.toLowerCase())
        throw new ProviderLoginRefusal(
          `This account belongs to ${recorded}, but Claude signed in as ${identity.email ?? "a different account"}. Nothing changed. Sign in as ${recorded} instead.`,
        );
      const { snapshot, providerId, creationId } = upgradeCandidate(definitionId);
      if (providerId !== upgrade.providerId || login.read(definitionId).status !== "verifying")
        throw new ClaudeOAuthDeliveryError();
      // With nothing recorded for this account, refuse a login another account already uses.
      const duplicate = duplicateIdentity(definitionId, identity.email, snapshot);
      if (duplicate)
        throw new ProviderLoginRefusal(
          `Claude signed in as ${identity.email}, which ${duplicate} already uses. Nothing changed. Sign in with this account's own Claude login.`,
        );
      // A daemon may have been replaced by an older release since the upgrade started.
      await assertUpgradeSupported();
      const definitions = structuredClone(snapshot.settings!.providerDefinitions!);
      definitions.find((item) => item.id === definitionId)!.accountSetup = {
        provider: "claude",
        creationId,
        signIn: "full",
      };
      await settings.update({
        expectedRevision: snapshot.revision,
        settings: { providerDefinitions: definitions },
      });
      upgrades.delete(definitionId);
      upgraded.add(definitionId);
      await refresher.connected(definitionId, identity).catch(() => {
        // Status then asks for sign-in again; the definition already uses full sign-in.
      });
    } catch (error) {
      if (verifiedGrant && upgrades.has(definitionId))
        await cli.logout(upgrade.configDir).catch(() => {});
      upgrades.delete(definitionId);
      throw error;
    }
    // Bindings switch, the setup token is withdrawn everywhere, then Dev receives access.
    void (async () => {
      await settings.reconcile();
      await overrides.setup?.reconcile();
      await refresher.reconcile();
    })().catch(() => {});
  }

  async function upgradeConfigDir(definitionId: string, providerId: string, revision: number) {
    assertReady("host");
    const binding = ClaudeOAuthBindingResponseSchema.parse(
      await post("host", "/api/installation/claude/oauth/upgrade-binding", {
        installationId: config.public.installationId,
        serverId: host!.serverId,
        definitionId,
        providerId,
        policyRevision: revision,
      }),
    );
    if (binding.providerId !== providerId) throw new ClaudeOAuthDeliveryError();
    return binding.configDir;
  }

  function upgradeState(definitionId: string): ProviderLoginState {
    const state = login.read(definitionId);
    return state.status !== "idle" && upgradeAttempts.get(definitionId) === state.attemptId
      ? state
      : { status: "idle" };
  }

  /** Mark the definition full sign-in and bind it on every environment, as setup-token does. */
  async function prepare(definitionId: string) {
    const { snapshot, selected } = definition(definitionId);
    if (selected.removed || selected.accountId) throw new ClaudeOAuthDeliveryError();
    // An existing setup-token account keeps its type; a new definition is needed instead.
    if (selected.accountSetup && selected.accountSetup.signIn !== "full")
      throw new ClaudeOAuthDeliveryError();
    const bindings = [...new Set(Object.values(selected.bindings))];
    if (bindings.length !== 1) throw new ClaudeOAuthDeliveryError();
    const providerId = bindings[0]!;
    const creationId = providerId.startsWith("claude-account-")
      ? providerId.slice("claude-account-".length)
      : "";
    if (
      !z.string().uuid().safeParse(creationId).success ||
      (selected.accountSetup && selected.accountSetup.creationId !== creationId)
    )
      throw new ClaudeOAuthDeliveryError();
    const complete = config.public.environments.every(
      (environment) => selected.bindings[environment.serverId] === providerId,
    );
    await assertFullSignInSupported();
    if (!selected.accountSetup || !complete) {
      const definitions = structuredClone(snapshot.settings!.providerDefinitions!);
      const promoted = definitions.find((item) => item.id === definitionId)!;
      promoted.accountSetup = { provider: "claude", creationId, signIn: "full" };
      promoted.bindings = Object.fromEntries(
        config.public.environments.map((environment) => [environment.serverId, providerId]),
      );
      await settings.update({
        expectedRevision: snapshot.revision,
        settings: { providerDefinitions: definitions },
      });
    }
    // Bindings must exist on every daemon before the Host can report its account path.
    await settings.reconcile();
  }

  return {
    read: (definitionId: string) => {
      definition(definitionId);
      return { login: login.read(definitionId), connection: refresher.status(definitionId) };
    },
    start: async (definitionId: string) => {
      await prepare(definitionId);
      return login.start(definitionId);
    },
    submit: (definitionId: string, attemptId: string, code: string) =>
      login.submitCode(definitionId, attemptId, code),
    cancel: async (definitionId: string, attemptId: string) => {
      // Verifying an upgrade may already be switching the account; let it finish.
      if (upgrades.has(definitionId) && login.read(definitionId).status === "verifying")
        return login.read(definitionId);
      const state = await login.cancel(definitionId, attemptId);
      if (!isActive(state)) upgrades.delete(definitionId);
      return state;
    },
    /** Whether the account can be upgraded, and the state of the upgrade sign-in. */
    upgradeRead: async (definitionId: string) => {
      definition(definitionId);
      let available = false;
      try {
        upgradeCandidate(definitionId);
        available = await upgradeSupported();
      } catch {
        // Not a setup-token account that can be upgraded.
      }
      return { available, login: upgradeState(definitionId) };
    },
    /** Signs the account in on the Host in its own directory; see finishUpgrade. */
    upgradeStart: async (definitionId: string) => {
      const { snapshot, providerId } = upgradeCandidate(definitionId);
      const current = login.read(definitionId);
      if (isActive(current)) {
        if (upgradeAttempts.get(definitionId) === current.attemptId) return current;
        throw new ClaudeOAuthDeliveryError();
      }
      if (overrides.setup?.signingIn(definitionId)) throw new ClaudeOAuthDeliveryError();
      await assertUpgradeSupported();
      const configDir = await upgradeConfigDir(definitionId, providerId, snapshot.revision);
      upgrades.set(definitionId, { providerId, configDir });
      const state = login.start(definitionId);
      if (state.status !== "idle") upgradeAttempts.set(definitionId, state.attemptId);
      return state;
    },
    /** True while an upgrade sign-in runs, so the setup-token flow stays out of the way. */
    upgrading: (definitionId: string) =>
      upgrades.has(definitionId) && isActive(login.read(definitionId)),
    /** Signs the Host account out with its own CLI, then withdraws Dev. Returns a warning. */
    signOut: async (definitionId: string): Promise<string | null> => {
      fullDefinition(definitionId);
      const current = login.read(definitionId);
      if (current.status !== "idle") await login.cancel(definitionId, current.attemptId);
      let warning: string | null = null;
      try {
        await cli.logout(await hostConfigDir(definitionId));
      } catch {
        warning =
          "Claude sign-out did not finish on the Host. Its saved sign-in may remain in this account's CLI storage.";
      }
      await refresher.signedOut(definitionId);
      await refresher.reconcile();
      return warning;
    },
    reconcile: () => refresher.reconcile(),
    dispose: () => login.dispose(),
  };
}
export type ClaudeOAuthRuntime = ReturnType<typeof createClaudeOAuthRuntime>;
