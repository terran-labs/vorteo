import pino from "pino";
import { codexAdoptionRetention, requireEnvironmentDaemon } from "../config.js";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  CODEX_START_FAILURE,
  ProviderLoginService,
} from "../../../services/provider-login/service.js";
import type { InstallationConfig } from "../config.js";
import { connectInstallationDaemon, createInstallationRegistrationAdmission } from "../daemon.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  createCodexAdoption,
  wireTarget,
  type DevUsageObservation,
} from "./codex-signin-adoption.js";
import {
  CODEX_SIGNIN_BINDING_ROUTE,
  CODEX_SIGNIN_LEASE_ROUTE,
  CODEX_SIGNIN_LEGACY_ROUTE,
  CODEX_SIGNIN_PROJECTION_ROUTE,
  CodexSignInBindingResponseSchema,
  CodexSignInDeliveryError,
  CodexSignInLeaseResponseSchema,
  CodexSignInProjectionReceiptSchema,
  CodexSignInRefused,
  codexRefusalReason,
  type CodexSignInProjectionDelivery,
} from "./codex-signin-delivery.js";
import { createCodexHostCli, readCodexHostGrant, type CodexHostCli } from "./codex-signin-host.js";
import { CodexSignInRefresher } from "./codex-signin-refresher.js";
import { HostRefreshSkipped, type HostRefreshPolicy } from "./host-owned-refresher.js";

// Sign-in start failures surface a short message in the interface; the cause goes to the log.
const logger = pino({ name: "vorteo-installation" });

/** A refresh stops this long before its Host lease ends. */
const LEASE_MARGIN_MS = 5_000;
/**
 * A loaded Host Codex refreshes by itself inside the token's last five minutes. The coordinator
 * keeps clear of that with a margin, and refreshes earlier, from 30 minutes before expiry.
 */
const NATIVE_REFRESH_WINDOW_MS = 10 * 60_000;
/**
 * Codex refreshes proactively when a request finds the access token within five minutes of
 * expiry, so with this little left the coordinator never starts Codex outside a lease.
 */
const UNLEASED_START_FLOOR_MS = 6 * 60_000;
/** The refresh timeout an older Host without the lease route always had. */
const UNLEASED_REFRESH_TIMEOUT_MS = 60_000;

interface DaemonFeatures {
  installationSettingsAuthority?: boolean;
  codexInstallationSignIn?: boolean;
  codexAccountAdoption?: boolean;
  codexLegacyPinByPath?: boolean;
}

interface RuntimeOverrides {
  /** Features each daemon advertises. Injected by tests. */
  daemonFeatures?: (kind: "host" | "container") => Promise<DaemonFeatures | undefined>;
  cli?: CodexHostCli;
  readGrant?: typeof readCodexHostGrant;
  fetch?: typeof fetch;
  now?: () => number;
  /** Dev's usage read for one provider ID. Injected by tests. */
  devUsage?: (providerId: string) => Promise<DevUsageObservation | null>;
}

interface HostBinding {
  request: {
    installationId: string;
    serverId: string;
    definitionId: string;
    providerId: string;
    policyRevision: number;
    legacy?: true;
  };
  codexHome: string;
}

/**
 * Owner-only coordinator service that connects a shared Codex account once for the whole
 * installation. Created only when the installation config sets `codexHostRefresh: true`. It
 * stores no token: the Host account's own CODEX_HOME holds the grant, the official Host Codex is
 * its only refresh writer, and every Dev binding receives access-only projections. A legacy
 * definition the owner adopted keeps its Dev binding and home; see codex-signin-adoption.ts.
 */
export function createCodexSignInRuntime(
  config: InstallationConfig,
  settings: InstallationSettingsService,
  assertRegistrationReadiness?: (target: "host" | "container-daemon") => void,
  overrides: RuntimeOverrides = {},
) {
  const assertReady = createInstallationRegistrationAdmission(config, assertRegistrationReadiness);
  const configuration = structuredClone(config);
  const file = join(config.stateDir, "codex-signin", "state.json");
  const adoptionFile = join(config.stateDir, "codex-signin", "adoption.json");
  /** Facts the first adoption release's strict reader would refuse; see codex-signin-adoption.ts. */
  const adoptionExtraFile = join(config.stateDir, "codex-signin", "adoption-extra.json");
  const cli = overrides.cli ?? createCodexHostCli();
  const readGrant = overrides.readGrant ?? readCodexHostGrant;
  const request = overrides.fetch ?? fetch;
  const now = overrides.now ?? Date.now;
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!host) throw new CodexSignInDeliveryError();
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
  const devUsage =
    overrides.devUsage ??
    (async (providerId: string): Promise<DevUsageObservation | null> => {
      const client = await connectInstallationDaemon(config, "container");
      try {
        const usage = (await client.listProviderUsage()).providers.find(
          (item) => item.providerId === providerId,
        );
        return usage
          ? {
              status: usage.status,
              fetchedAt: usage.fetchedAt ?? null,
              authRecovery: usage.authRecovery !== undefined,
            }
          : null;
      } finally {
        await client.close();
      }
    });

  /** Every daemon must know the binding and projection routes before the Host signs in. */
  async function assertSupported() {
    for (const environment of config.public.environments) {
      assertReady(environment.kind === "host" ? "host" : "container-daemon");
      const features = await daemonFeatures(environment.kind);
      if (
        features?.installationSettingsAuthority !== true ||
        features.codexInstallationSignIn !== true
      )
        throw new CodexSignInDeliveryError();
    }
  }

  const journal = {
    read: () => readClaudeSetupFile(adoptionFile) ?? [],
    write: (records: unknown[]) => writeClaudeSetupFile(adoptionFile, records),
    readExtra: () => readClaudeSetupFile(adoptionExtraFile) ?? {},
    writeExtra: (extras: Record<string, unknown>) =>
      writeClaudeSetupFile(adoptionExtraFile, extras),
  };

  /**
   * An account created for the installation, or a legacy one the owner adopted. Unlinked
   * accounts need verification first.
   */
  function definition(definitionId: string) {
    const snapshot = settings.snapshot();
    const selected = snapshot.settings?.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    if (!selected || selected.providerType !== "codex" || snapshot.conflicts)
      throw new CodexSignInDeliveryError();
    if (selected.accountSetup?.provider === "codex")
      return {
        snapshot,
        selected,
        adopted: null,
        providerId: `codex-account-${selected.accountSetup.creationId}`,
      };
    const adopted = adoption.delivering(definitionId);
    if (
      !adopted ||
      selected.accountSetup !== undefined ||
      selected.bindings[host!.serverId] !== adopted.hostProviderId ||
      selected.bindings[adopted.devServerId] !== adopted.devProviderId
    )
      throw new CodexSignInDeliveryError();
    return { snapshot, selected, adopted, providerId: adopted.hostProviderId };
  }

  /**
   * What the sign-in panel may read. A legacy definition stays readable in every adoption state,
   * because its record can fail, cancel or end while the panel polls; its status then reports no
   * delivery. Only reads relax this: everything that signs in, refreshes or delivers still goes
   * through definition().
   */
  function readable(definitionId: string): void {
    try {
      definition(definitionId);
    } catch (error) {
      const selected = settings
        .snapshot()
        .settings?.providerDefinitions?.find((item) => item.id === definitionId);
      const legacy =
        selected?.providerType === "codex" &&
        selected.accountId !== undefined &&
        selected.accountSetup === undefined;
      if (!legacy || !adoption.record(definitionId)) throw error;
    }
  }

  function excludedOn(
    selected: ReturnType<typeof definition>["selected"],
    serverId: string,
  ): boolean {
    return (
      selected.removed === true ||
      selected.policy.enabled === false ||
      Boolean(
        settings
          .snapshot()
          .settings?.resourceExclusions[serverId]?.providerIds?.includes(selected.id),
      )
    );
  }

  function policy(definitionId: string): HostRefreshPolicy {
    const { snapshot, selected, adopted } = definition(definitionId);
    const removed = selected.removed === true;
    if (adopted)
      return {
        revision: snapshot.revision,
        removed,
        targets: [
          {
            serverId: adopted.devServerId,
            providerId: adopted.devProviderId,
            excluded: excludedOn(selected, adopted.devServerId),
          },
        ],
      };
    return {
      revision: snapshot.revision,
      removed,
      targets: config.public.environments
        .filter((environment) => environment.kind === "container")
        .filter((environment) => Object.hasOwn(selected.bindings, environment.serverId))
        .map((environment) => ({
          serverId: environment.serverId,
          providerId: selected.bindings[environment.serverId]!,
          excluded: excludedOn(selected, environment.serverId),
        })),
    };
  }

  async function send(target: "host" | "container", route: string, body: unknown) {
    if (!isDeepStrictEqual(config, configuration)) throw new CodexSignInDeliveryError();
    // Host-only installations have no Dev; requireEnvironmentDaemon refuses that target plainly.
    const daemon = requireEnvironmentDaemon(config, target);
    // Explicit loopback endpoints are validated by installation config, never supplied by clients.
    return request(`http://${daemon.endpoint}${route}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${daemon.password}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A 409 is the daemon's answer, kept distinct from an unreachable daemon. */
  async function post(target: "host" | "container", route: string, body: unknown) {
    const response = await send(target, route, body);
    if (response.status === 409)
      throw new CodexSignInRefused(codexRefusalReason(await response.json().catch(() => null)));
    if (!response.ok) throw new CodexSignInDeliveryError();
    return response.json();
  }

  async function bindingHome(requestBody: HostBinding["request"]): Promise<string> {
    assertReady("host");
    const binding = CodexSignInBindingResponseSchema.parse(
      await post("host", CODEX_SIGNIN_BINDING_ROUTE, requestBody),
    );
    if (binding.providerId !== requestBody.providerId) throw new CodexSignInDeliveryError();
    return binding.codexHome;
  }

  /** The Host binding's exact CODEX_HOME, cached per policy revision. */
  const homes = new Map<string, { revision: number; binding: HostBinding }>();
  async function hostBinding(definitionId: string): Promise<HostBinding> {
    const { snapshot, selected, providerId, adopted } = definition(definitionId);
    const cached = homes.get(definitionId);
    if (cached?.revision === snapshot.revision) return cached.binding;
    if (selected.bindings[host!.serverId] !== providerId) throw new CodexSignInDeliveryError();
    const requestBody: HostBinding["request"] = {
      installationId: config.public.installationId,
      serverId: host!.serverId,
      definitionId,
      providerId,
      policyRevision: snapshot.revision,
      ...(adopted ? { legacy: true as const } : {}),
    };
    const binding = { request: requestBody, codexHome: await bindingHome(requestBody) };
    homes.set(definitionId, { revision: snapshot.revision, binding });
    return binding;
  }
  async function hostCodexHome(definitionId: string): Promise<string> {
    return (await hostBinding(definitionId)).codexHome;
  }

  /**
   * The Host's own Codex sessions are its normal refresh writer, and Codex does not lock the
   * network refresh across processes. A loaded Codex refreshes only while a request runs inside
   * the token's last five minutes, after rereading `auth.json`. The coordinator reads `auth.json`
   * first. With more than six minutes left it starts Codex before the lease, so a slow startup
   * holds no lease. With six minutes or less left, or no readable expiry, any request to the
   * starting Codex could refresh proactively, so it starts Codex only under the lease, bounded
   * by the lease's time. Then it takes a lease, which the Host refuses while a session on the
   * account starts or runs a turn; leaves the last ten minutes to a loaded session; and stops
   * the refresh before the lease ends.
   */
  async function leasedRefresh(binding: HostBinding): Promise<void> {
    const before = readGrant(binding.codexHome)?.expiresAt ?? null;
    const startUnderLease = before === null || before - now() <= UNLEASED_START_FLOOR_MS;
    let session = startUnderLease ? null : await cli.openRefresh(binding.codexHome);
    let leaseId: string | null = null;
    try {
      let lease;
      try {
        lease = CodexSignInLeaseResponseSchema.parse(
          await post("host", CODEX_SIGNIN_LEASE_ROUTE, {
            ...binding.request,
            operation: "acquire",
          }),
        );
      } catch {
        throw new HostRefreshSkipped("lease_unavailable");
      }
      if (!lease.granted) throw new HostRefreshSkipped("lease_unavailable");
      leaseId = lease.leaseId;
      const expiresAt = readGrant(binding.codexHome)?.expiresAt ?? null;
      if (lease.loaded && (expiresAt === null || expiresAt - now() < NATIVE_REFRESH_WINDOW_MS))
        throw new HostRefreshSkipped("native_session");
      if (!session) {
        const startBudget = lease.expiresAt - now() - LEASE_MARGIN_MS;
        if (startBudget <= 0) throw new HostRefreshSkipped("lease_expired");
        try {
          session = await cli.openRefresh(binding.codexHome, { startTimeoutMs: startBudget });
        } catch {
          // Startup failed or outran the lease; the process is already ended.
          throw new HostRefreshSkipped("lease_expired");
        }
      }
      const remaining = lease.expiresAt - now() - LEASE_MARGIN_MS;
      if (remaining <= 0 || (await session.refresh(remaining)) === "timed-out")
        throw new HostRefreshSkipped("lease_expired");
    } finally {
      // Ending the process first means nothing can still be refreshing once the lease is gone.
      await session?.close().catch(() => {});
      if (leaseId)
        await post("host", CODEX_SIGNIN_LEASE_ROUTE, {
          ...binding.request,
          operation: "release",
          leaseId,
        }).catch(() => {
          // The Host ends the lease by itself.
        });
    }
  }

  /** Every Host refresh the coordinator starts, leased where the Host supports it. */
  async function hostRefresh(definitionId: string): Promise<void> {
    const binding = await hostBinding(definitionId);
    // COMPAT(codexRefreshLease): added after 26.11.2100, remove once the Host daemon floor
    // advertises `codexAccountAdoption`. A Host daemon from before the lease advertises no
    // `codexAccountAdoption` and has no lease route. Managed accounts keep the refresh they had
    // before, without a lease, rather than stop renewing until the Host is updated. Adoption
    // needs that capability, so an adopted account on such a Host fails visibly instead.
    if ((await daemonFeatures("host"))?.codexAccountAdoption !== true) {
      if (definition(definitionId).adopted) throw new CodexSignInDeliveryError();
      logger.warn(
        { definitionId },
        "Host daemon has no Codex refresh lease; refreshing without one as before",
      );
      await unleasedRefresh(binding.codexHome);
      return;
    }
    await leasedRefresh(binding);
  }

  /** The refresh before the lease existed: start, refresh within 60 seconds, end. */
  async function unleasedRefresh(codexHome: string): Promise<void> {
    const session = await cli.openRefresh(codexHome);
    try {
      if ((await session.refresh(UNLEASED_REFRESH_TIMEOUT_MS)) === "timed-out")
        throw new CodexSignInDeliveryError();
    } finally {
      await session.close().catch(() => {});
    }
  }

  const refresher = new CodexSignInRefresher({
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(file) ?? [],
    persist: (state) => writeClaudeSetupFile(file, state),
    policy,
    grant: async (definitionId) => readGrant(await hostCodexHome(definitionId)),
    refresh: hostRefresh,
    log: (event) =>
      logger.info(
        event,
        event.kind === "refreshSkipped" ? "Codex sign-in refresh skipped" : "Codex sign-in refresh",
      ),
    deliver: async (delivery: CodexSignInProjectionDelivery) => {
      const environment = config.public.environments.find(
        (item) => item.serverId === delivery.serverId,
      );
      if (environment?.kind !== "container") throw new CodexSignInDeliveryError();
      // Withdrawal remains available while ordinary Dev work is fenced.
      if (delivery.access !== null) assertReady("container-daemon");
      const adopted = definition(delivery.definitionId).adopted;
      // A Host re-sign-in, from the app or a shell, can name another person. Refused before it
      // leaves the coordinator; the owner confirms the new person explicitly.
      if (
        adopted &&
        delivery.access !== null &&
        !adoption.admitsHostIdentity(delivery.definitionId, delivery.access)
      )
        throw new CodexSignInDeliveryError();
      const body = adopted
        ? {
            ...delivery,
            adoption: {
              target: wireTarget(adopted.target!),
              keepLocalSignIn:
                adopted.copyForgottenAt === null &&
                codexAdoptionRetention(config, delivery.definitionId).mode !== "none",
            },
          }
        : delivery;
      let receipt;
      try {
        receipt = CodexSignInProjectionReceiptSchema.parse(
          await post("container", CODEX_SIGNIN_PROJECTION_ROUTE, body),
        );
      } catch (error) {
        if (adopted && error instanceof CodexSignInRefused && error.reason)
          adoption.refused(delivery.definitionId, error.reason);
        throw error;
      }
      if (adopted && receipt.replacedLocally) adoption.replacedLocally(delivery.definitionId);
      return receipt;
    },
    now,
  });

  const adoption = createCodexAdoption({
    config,
    settings,
    journal,
    refresher,
    supported: async () => {
      for (const environment of config.public.environments) {
        assertReady(environment.kind === "host" ? "host" : "container-daemon");
        const features = await daemonFeatures(environment.kind);
        if (
          features?.installationSettingsAuthority !== true ||
          features.codexInstallationSignIn !== true ||
          features.codexAccountAdoption !== true
        )
          return false;
      }
      return true;
    },
    pinByPath: async () => (await daemonFeatures("container"))?.codexLegacyPinByPath === true,
    hostHome: (definitionId, hostProviderId, revision) =>
      bindingHome({
        installationId: config.public.installationId,
        serverId: host.serverId,
        definitionId,
        providerId: hostProviderId,
        policyRevision: revision,
        legacy: true,
      }),
    dev: (body) => post("container", CODEX_SIGNIN_LEGACY_ROUTE, body),
    readGrant,
    devUsage,
    retention: (definitionId) => codexAdoptionRetention(config, definitionId),
    now,
  });

  const login = new ProviderLoginService({
    startFailureMessage: () => CODEX_START_FAILURE,
    logger,
    getClient: (definitionId) => ({
      openAccountLoginSession: async () => {
        if (definition(definitionId).selected.removed) throw new CodexSignInDeliveryError();
        return cli.loginSession(await hostCodexHome(definitionId));
      },
    }),
    onConnected: (definitionId) => {
      void (async () => {
        const identity = await cli.identity(await hostCodexHome(definitionId));
        await refresher.connected(definitionId, identity);
        await refresher.reconcile();
      })().catch(() => {});
    },
  });

  /**
   * Bind the shared account on every environment before the Host reports its home. An adopted
   * legacy account keeps its bindings; signing in again on the Host repairs Dev as well.
   */
  async function prepare(definitionId: string) {
    const { snapshot, selected, providerId, adopted } = definition(definitionId);
    if (selected.removed) throw new CodexSignInDeliveryError();
    if (adopted) {
      await assertSupported();
      return;
    }
    // A binding to any other provider ID is an unlinked account that needs verification first.
    if (Object.values(selected.bindings).some((bound) => bound !== providerId))
      throw new CodexSignInDeliveryError();
    await assertSupported();
    const complete = config.public.environments.every(
      (environment) => selected.bindings[environment.serverId] === providerId,
    );
    if (!complete) {
      const definitions = structuredClone(snapshot.settings!.providerDefinitions!);
      definitions.find((item) => item.id === definitionId)!.bindings = Object.fromEntries(
        config.public.environments.map((environment) => [environment.serverId, providerId]),
      );
      await settings.update({
        expectedRevision: snapshot.revision,
        settings: { providerDefinitions: definitions },
      });
    }
    await settings.reconcile();
  }

  return {
    read: (definitionId: string) => {
      readable(definitionId);
      return { login: login.read(definitionId), connection: refresher.status(definitionId) };
    },
    start: async (definitionId: string) => {
      await prepare(definitionId);
      return login.start(definitionId);
    },
    cancel: (definitionId: string, attemptId: string) => login.cancel(definitionId, attemptId),
    /**
     * Signs the Host account out with its own Codex, which revokes the grant for every
     * environment, then withdraws Dev. Returns a warning. Un-adopt never comes through here.
     */
    signOut: async (definitionId: string): Promise<string | null> => {
      definition(definitionId);
      const current = login.read(definitionId);
      if (current.status !== "idle") await login.cancel(definitionId, current.attemptId);
      let warning: string | null = null;
      try {
        await cli.logout(await hostCodexHome(definitionId));
      } catch {
        warning =
          "Codex sign-out did not finish on the Host. Its saved sign-in may remain in this account's CODEX_HOME.";
      }
      await refresher.signedOut(definitionId);
      await refresher.reconcile();
      return warning;
    },
    /** Owner selection of a legacy account, from the owner route only. */
    adopt: (definitionId: string) => adoption.adopt(definitionId),
    /** Withdraws an adoption without signing the Host out. Owner route only. */
    unadopt: (definitionId: string) => adoption.unadopt(definitionId),
    adoption: (definitionId: string) => adoption.record(definitionId) ?? null,
    /** Every legacy Codex definition, whether it can be adopted, and its record. */
    adoptions: () => adoption.legacy(),
    reconcile: async () => {
      try {
        await adoption.reconcile();
      } finally {
        await refresher.reconcile();
      }
    },
    dispose: () => login.dispose(),
  };
}
export type CodexSignInRuntime = ReturnType<typeof createCodexSignInRuntime>;
