import pino from "pino";
import type { ClaudeOAuthRecoveryRequest } from "./claude-oauth-recovery.js";
import { isDeepStrictEqual } from "node:util";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import {
  CLAUDE_START_FAILURE,
  ProviderLoginRefusal,
  ProviderLoginService,
} from "../../../services/provider-login/service.js";
import {
  claudeCoordinatorRefreshEnabled,
  requireEnvironmentDaemon,
  type InstallationConfig,
} from "../config.js";
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
import {
  adoptClaudeGrant,
  authorityOwner,
  claudeAuthorityDir,
  claudeAuthorityDisabledFile,
  claudeAuthorityEnabledFile,
  platformCredentialStore,
  projectClaudeHostAccess,
  rememberAuthorityToken,
  removeAuthority,
  restoreClaudeGrant,
  type ClaudeCredentialStore,
} from "./claude-oauth-authority.js";
import type { HostRefreshEvent } from "./host-owned-refresher.js";

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
  /** Raw CLI credential storage for authority custody. Injected by tests. */
  store?: ClaudeCredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** The setup-token side of the same accounts, so the two sign-ins never overlap. */
  setup?: { signingIn(definitionId: string): boolean; reconcile(): Promise<void> };
}

/**
 * Owner-only coordinator service for full sign-in Claude accounts with Host-owned refresh.
 * Created only when the installation config sets `claudeHostRefresh: true`. It stores no token in
 * its state: the grant lives in CLI storage for a coordinator-only authority directory, the Host
 * account directory and Dev receive access-only projections, and the coordinator is the only
 * refresher, for accounts opted in with `claude-oauth/authority-enabled/<hash>`. See
 * claude-oauth-authority.ts. Removing the marker, or creating `claude-oauth/authority-disabled`,
 * returns the login to its account directory on the next read (rollback).
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
  const diagnosticsFile = join(config.stateDir, "claude-oauth", "diagnostics.json");
  const cli = overrides.cli ?? createClaudeHostCli();
  const readGrant = overrides.readGrant ?? readClaudeOAuthGrant;
  const store = overrides.store ?? platformCredentialStore();
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
      hostEnabled:
        !removed &&
        selected.policy.enabled !== false &&
        !snapshot.settings?.resourceExclusions[host!.serverId]?.providerIds?.includes(selected.id),
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
    if (
      binding.providerId !== providerId ||
      fullDefinition(definitionId).snapshot.revision !== snapshot.revision
    )
      throw new ClaudeOAuthDeliveryError();
    directories.set(definitionId, { revision: snapshot.revision, configDir: binding.configDir });
    return binding.configDir;
  }

  const authorityDir = (definitionId: string) => claudeAuthorityDir(config.stateDir, definitionId);
  const present = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  /**
   * Opt-in per account; the global kill switch wins. See claude-oauth-authority.ts. Custody also
   * needs coordinator refresh: the authority holds the only refresh token, so without it nothing
   * would renew the account, and its grant returns to the account directory instead.
   */
  async function custodyEnabled(definitionId: string): Promise<boolean> {
    if (!claudeCoordinatorRefreshEnabled(config)) return false;
    if (await present(claudeAuthorityDisabledFile(config.stateDir))) return false;
    return present(claudeAuthorityEnabledFile(config.stateDir, definitionId));
  }

  /**
   * Without custody this is the 601 path: the account directory's own grant, after returning any
   * authority grant to it. With custody it adopts any new refresh token from the account
   * directory, reads the authority and projects its access back. Account directory and Host
   * daemon failures are logged and never stop the authority's own renewal.
   */
  async function hostGrant(definitionId: string) {
    const authority = authorityDir(definitionId);
    if (!(await custodyEnabled(definitionId))) {
      const agentDir = await hostConfigDir(definitionId);
      // Never adopted: exactly the previous path, with no extra storage reads.
      if (!(await present(authority))) return readGrant(agentDir);
      try {
        if ((await restoreClaudeGrant({ agentDir, authorityDir: authority, store })) === "restored")
          logger.warn({ definitionId }, "Claude sign-in returned to its account directory");
      } catch {
        logger.warn({ definitionId }, "Claude sign-in return to its account directory is pending");
      }
      // Until the return finishes, the authority still holds the only renewable grant.
      const held = (await present(authority)) ? await readGrant(authority) : null;
      return held?.hasRefreshToken ? held : readGrant(agentDir);
    }
    let agentDir: string | null = null;
    try {
      agentDir = await hostConfigDir(definitionId);
      const adoption = await adoptClaudeGrant({
        definitionId,
        agentDir,
        authorityDir: authority,
        store,
        now: now(),
      });
      if (adoption !== "none")
        logger[adoption === "deferred" ? "warn" : "info"](
          { definitionId, adoption },
          "Claude sign-in custody",
        );
    } catch {
      logger.warn({ definitionId }, "Claude sign-in adoption is pending");
    }
    const held = await readGrant(authority);
    if (held?.hasRefreshToken) {
      await rememberAuthorityToken(authority, store).catch(() => {
        logger.warn({ definitionId }, "Claude refresh token record is pending");
      });
      if (agentDir) {
        try {
          if (
            (await projectClaudeHostAccess({ agentDir, authorityDir: authority, store })) ===
            "written"
          )
            logger.info(
              { definitionId, expiresAt: held.expiresAt },
              "Claude Host access copy updated",
            );
        } catch {
          logger.warn({ definitionId }, "Claude Host access copy is pending");
        }
      }
      return held;
    }
    // No live authority grant: only a sign-in still waiting for adoption counts. An access-only
    // copy left from a dead or deleted authority must ask for sign-in, not look connected.
    if (agentDir === null) throw new ClaudeOAuthDeliveryError();
    const own = await readGrant(agentDir);
    return own?.hasRefreshToken ? own : null;
  }

  /** The directory the official CLI refreshes in: the authority once it holds the grant. */
  async function refreshDir(definitionId: string): Promise<string> {
    const authority = authorityDir(definitionId);
    if (await present(authority)) {
      const held = await readGrant(authority);
      if (held?.hasRefreshToken) return authority;
    }
    return hostConfigDir(definitionId);
  }

  /** Deletes the authority of an account that was removed from the installation. */
  async function purgeRemovedAuthorities(): Promise<void> {
    const snapshot = settings.snapshot();
    if (!snapshot.settings?.providerDefinitions || snapshot.conflicts) return;
    const root = join(config.stateDir, "claude-oauth", "authority");
    const names = await readdir(root).catch(() => [] as string[]);
    for (const name of names) {
      const dir = join(root, name);
      const owner = await authorityOwner(dir);
      if (!owner) continue;
      const selected = snapshot.settings.providerDefinitions.find((item) => item.id === owner);
      if (selected && !selected.removed) continue;
      await refresher.exclusive(owner, () => removeAuthority(dir, store));
      logger.info({ definitionId: owner }, "Claude authority deleted after account removal");
    }
  }

  function logRefresh(event: HostRefreshEvent) {
    if (event.kind === "signInLost")
      logger.warn(event, "Claude sign-in is gone from its account directory; sign in again");
    else if (event.kind === "expiring")
      logger.warn(event, "Claude access token is expiring without a successful refresh");
    else if (event.outcome === "refreshed") logger.info(event, "Claude sign-in refreshed");
    else logger.warn(event, "Claude sign-in refresh did not renew the token");
  }

  const refresher = new ClaudeOAuthRefresher(
    {
      installationId: config.public.installationId,
      read: () => readClaudeSetupFile(file) ?? [],
      persist: (state) => writeClaudeSetupFile(file, state),
      diagnostics: {
        read: () => readClaudeSetupFile(diagnosticsFile) ?? [],
        persist: (diagnostics) => writeClaudeSetupFile(diagnosticsFile, diagnostics),
      },
      policy,
      grant: hostGrant,
      log: logRefresh,
      refresh: async (definitionId) => {
        const revision = policy(definitionId).revision;
        const configDir = await refreshDir(definitionId);
        if (policy(definitionId).revision !== revision) throw new ClaudeOAuthDeliveryError();
        await cli.refresh(configDir);
      },
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
    },
    { cliRefresh: claudeCoordinatorRefreshEnabled(config) },
  );

  async function recover(
    kind: "host" | "container",
    input: ClaudeOAuthRecoveryRequest,
  ): Promise<void> {
    const environment = config.public.environments.find((item) => item.kind === kind);
    if (!environment) throw new ClaudeOAuthDeliveryError();
    const snapshot = settings.snapshot();
    const candidates = snapshot.settings?.providerDefinitions?.filter(
      (item) => item.bindings[environment.serverId] === input.providerId,
    );
    if (candidates?.length !== 1) throw new ClaudeOAuthDeliveryError();
    const selected = candidates[0]!;
    const current = policy(selected.id);
    const allowed =
      kind === "host"
        ? current.hostEnabled
        : current.targets.some(
            (target) => target.serverId === environment.serverId && !target.excluded,
          );
    if (!allowed || current.removed || !refresher.status(selected.id).signedIn)
      throw new ClaudeOAuthDeliveryError();
    assertReady(kind === "host" ? "host" : "container-daemon");
    const binding = ClaudeOAuthBindingResponseSchema.parse(
      await post(kind, "/api/installation/claude/oauth/binding", {
        installationId: config.public.installationId,
        serverId: environment.serverId,
        definitionId: selected.id,
        providerId: input.providerId,
        policyRevision: current.revision,
      }),
    );
    if (
      binding.providerId !== input.providerId ||
      binding.configDir !== input.configDir ||
      policy(selected.id).revision !== current.revision
    )
      throw new ClaudeOAuthDeliveryError();
    await refresher.recover(selected.id, current.revision);
    if (policy(selected.id).revision !== current.revision) throw new ClaudeOAuthDeliveryError();
  }

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
    recover,
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
      // In the account's queue, so no refresh or adoption runs halfway through sign-out. The
      // coordinator's grant goes first, so it cannot be adopted back.
      await refresher.exclusive(definitionId, async () => {
        const authority = authorityDir(definitionId);
        if (await present(authority)) {
          await cli.logout(authority).catch(() => {});
          await removeAuthority(authority, store).catch(() => {
            logger.warn({ definitionId }, "Claude authority deletion is pending");
          });
        }
        try {
          await cli.logout(await hostConfigDir(definitionId));
        } catch {
          warning =
            "Claude sign-out did not finish on the Host. Its saved sign-in may remain in this account's CLI storage.";
        }
      });
      await refresher.signedOut(definitionId);
      await refresher.reconcile();
      return warning;
    },
    reconcile: async () => {
      await purgeRemovedAuthorities().catch(() => {
        logger.warn("Claude authority cleanup is pending");
      });
      await refresher.reconcile();
    },
    dispose: () => login.dispose(),
  };
}
export type ClaudeOAuthRuntime = ReturnType<typeof createClaudeOAuthRuntime>;
