import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ErrorRequestHandler, Express, Response } from "express";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { createCodexAccount } from "../../../services/provider-login/create-account.js";
import { launchCodexHome } from "../../agent/create-agent/create.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import { secureAccountHome } from "./claude-setup-consumer.js";
import {
  CODEX_SIGNIN_BINDING_ROUTE,
  CODEX_SIGNIN_LEASE_ROUTE,
  CODEX_SIGNIN_LEGACY_ROUTE,
  CODEX_SIGNIN_PROJECTION_ROUTE,
  CodexSignInBindingRequestSchema,
  CodexSignInDeliveryError,
  CodexSignInLeaseRequestSchema,
  CodexSignInLegacyRequestSchema,
  CodexSignInProjectionDeliverySchema,
  CodexSignInProjectionReceiptSchema,
  CodexSignInProjectionService,
  type CodexLegacyTarget,
  type CodexSignInBindingRequest,
} from "./codex-signin-delivery.js";
import {
  CODEX_SIGNIN_STATE_DIRECTORY,
  writeCodexAccessProjection,
} from "./codex-signin-auth-file.js";
import type { CodexRefreshLeases } from "./codex-signin-lease.js";
import {
  forgetLegacyCodexSignIn,
  pinCodexHome,
  restoreLegacyCodexSignIn,
  sharesCodexHome,
  writeLegacyCodexProjection,
} from "./codex-signin-legacy-home.js";
import { HostProjectionRefusal } from "./host-owned-projection.js";

interface ConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  onApplied?(providerId: string): void;
  /** Present on daemons that run agents; without it the lease route refuses. */
  codexRefreshLeases?: CodexRefreshLeases;
  /** Whether an agent session, or one being started, uses this provider ID. */
  providerInUse?(providerId: string): boolean;
  /** The daemon's environment, for the CODEX_HOME a provider without its own inherits. Tests. */
  daemonEnv?: NodeJS.ProcessEnv;
}

const MANAGED_PROVIDER_ID =
  /^codex-account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LegacyScope {
  installationId: string;
  serverId: string;
  definitionId: string;
  providerId: string;
  policyRevision: number;
}

/**
 * Mounted behind daemon bearer authentication. The binding route returns only the account's
 * CODEX_HOME, never a credential: the coordinator (same user, same Host) signs in and reads the
 * Host grant itself. The projection route writes access-only tokens on Dev. The lease route
 * lets the coordinator refresh a Host account no session is using. The legacy route pins and
 * restores an adopted legacy home on Dev.
 */
export function mountCodexSignInConsumer(app: Express, options: ConsumerOptions): void {
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(CODEX_SIGNIN_BINDING_ROUTE, parseFailure);
  app.use(CODEX_SIGNIN_PROJECTION_ROUTE, parseFailure);
  app.use(CODEX_SIGNIN_LEASE_ROUTE, parseFailure);
  app.use(CODEX_SIGNIN_LEGACY_ROUTE, parseFailure);
  const consumers = new Map<string, CodexSignInProjectionService>();

  async function authorize(
    request: CodexSignInBindingRequest,
  ): Promise<{ definition: InstallationProvider; excluded: boolean }> {
    const authority = await options.store.readInstallationSettingsAuthority();
    const definition = authority?.settings.providerDefinitions?.find(
      (item) => item.id === request.definitionId,
    );
    if (
      !authority ||
      !definition ||
      authority.installationId !== request.installationId ||
      authority.serverId !== request.serverId ||
      authority.revision !== request.policyRevision ||
      definition.providerType !== "codex" ||
      definition.bindings[request.serverId] !== request.providerId
    )
      throw new CodexSignInDeliveryError();
    const managed =
      definition.accountSetup?.provider === "codex" &&
      request.providerId === `codex-account-${definition.accountSetup.creationId}`;
    if (!managed && !(request.legacy === true && legacyHostBinding(request, definition)))
      throw new CodexSignInDeliveryError();
    const excluded =
      definition.removed === true ||
      definition.policy.enabled === false ||
      authority.settings.resourceExclusions[request.serverId]?.providerIds?.includes(
        definition.id,
      ) === true;
    return { definition, excluded };
  }

  /**
   * An adopted legacy definition qualifies on the Host only where it is already bound to a
   * managed entry that records the same installation account.
   */
  function legacyHostBinding(
    request: CodexSignInBindingRequest,
    definition: InstallationProvider,
  ): boolean {
    return (
      definition.accountSetup === undefined &&
      definition.accountId !== undefined &&
      MANAGED_PROVIDER_ID.test(request.providerId) &&
      options.store.get().providers[request.providerId]?.installationAccountId ===
        definition.accountId
    );
  }

  /** The managed home, which must also be the binding's configured CODEX_HOME. */
  function accountHome(providerId: string): string {
    const home = join(options.paseoHome, "codex-accounts", providerId);
    const configured = ProviderOverrideSchema.safeParse(options.store.get().providers[providerId]);
    if (!configured.success || configured.data.env?.CODEX_HOME !== home)
      throw new CodexSignInDeliveryError();
    return home;
  }

  /**
   * A legacy definition still bound here to the named provider ID, and that provider's configured
   * CODEX_HOME. Fresh settings decide every request; nothing is cached.
   */
  async function authorizeLegacy(
    request: LegacyScope,
  ): Promise<{ excluded: boolean; home: string }> {
    const authority = await options.store.readInstallationSettingsAuthority();
    const definition = authority?.settings.providerDefinitions?.find(
      (item) => item.id === request.definitionId,
    );
    const local = ProviderOverrideSchema.safeParse(
      options.store.get().providers[request.providerId],
    );
    const home = local.success && !local.data.removed ? local.data.env?.CODEX_HOME : undefined;
    if (
      !authority ||
      !definition ||
      authority.installationId !== request.installationId ||
      authority.serverId !== request.serverId ||
      authority.revision !== request.policyRevision ||
      definition.providerType !== "codex" ||
      definition.accountSetup !== undefined ||
      definition.bindings[request.serverId] !== request.providerId ||
      !home ||
      !isAbsolute(home)
    )
      throw new CodexSignInDeliveryError();
    const excluded =
      definition.removed === true ||
      definition.policy.enabled === false ||
      authority.settings.resourceExclusions[request.serverId]?.providerIds?.includes(
        definition.id,
      ) === true;
    return { excluded, home };
  }

  /** The built-in provider an `extends` chain ends at, or null for a cycle. */
  function rootProvider(providers: Record<string, unknown>, providerId: string): string | null {
    const visited = new Set<string>();
    let current = providerId;
    while (!visited.has(current)) {
      visited.add(current);
      const parsed = ProviderOverrideSchema.safeParse(providers[current]);
      const next = parsed.success ? parsed.data.extends : undefined;
      if (!next) return current;
      current = next;
    }
    return null;
  }

  /**
   * Every Codex provider ID on this daemon, the built-in `codex` included, with the CODEX_HOME
   * its sessions launch with: its own, the nearest one along its `extends` chain, the daemon's
   * CODEX_HOME, or Codex's default `~/.codex`, the same resolution a launch uses.
   */
  function codexLaunchHomes(): Array<{ providerId: string; home: string }> {
    const providers = options.store.get().providers ?? {};
    const env = options.daemonEnv ?? process.env;
    const fallback = join(env.HOME || homedir(), ".codex");
    return [...new Set(["codex", ...Object.keys(providers)])].flatMap((providerId) => {
      const configured = providers[providerId];
      if (configured !== undefined) {
        const parsed = ProviderOverrideSchema.safeParse(configured);
        if (!parsed.success || parsed.data.removed) return [];
      }
      if (rootProvider(providers, providerId) !== "codex") return [];
      const home = launchCodexHome("codex", { providers }, providerId, env) || fallback;
      return [{ providerId, home }];
    });
  }

  /**
   * The directory a `forget-copy` request may clear: a legacy Codex definition of this
   * installation, and a directory that still pins exactly to the recorded target. The current
   * binding and other providers do not matter, because only the backup file is removed.
   */
  async function authorizeForget(
    request: LegacyScope & { target: CodexLegacyTarget },
  ): Promise<string> {
    const authority = await options.store.readInstallationSettingsAuthority();
    const definition = authority?.settings.providerDefinitions?.find(
      (item) => item.id === request.definitionId,
    );
    if (
      !authority ||
      !definition ||
      authority.installationId !== request.installationId ||
      authority.serverId !== request.serverId ||
      authority.revision !== request.policyRevision ||
      definition.providerType !== "codex" ||
      definition.accountId === undefined ||
      definition.accountSetup !== undefined
    )
      throw new CodexSignInDeliveryError();
    let current: CodexLegacyTarget;
    try {
      current = pinCodexHome(request.target.realpath);
    } catch {
      throw new HostProjectionRefusal("target_changed");
    }
    if (!isDeepStrictEqual(current, request.target))
      throw new HostProjectionRefusal("target_changed");
    return current.realpath;
  }

  /**
   * Every other Codex provider's launch home, to refuse two bindings that share one directory.
   * This includes homes a provider only inherits, such as the built-in provider's `~/.codex`.
   */
  function otherHomes(providerId: string): string[] {
    return codexLaunchHomes().flatMap((item) =>
      item.providerId === providerId ? [] : [item.home],
    );
  }

  /**
   * Whether any session uses the adopted home: on the binding itself, or on any other Codex
   * provider ID whose launch home is the same directory.
   */
  function homeInUse(providerId: string, home: string): boolean {
    if (!options.providerInUse) throw new CodexSignInDeliveryError();
    if (options.providerInUse(providerId)) return true;
    let target: CodexLegacyTarget;
    try {
      target = pinCodexHome(home);
    } catch {
      // An unpinnable home cannot be adopted; count it as busy rather than guess.
      return true;
    }
    return codexLaunchHomes().some(
      (item) =>
        item.providerId !== providerId &&
        sharesCodexHome(target, [item.home]) &&
        options.providerInUse!(item.providerId),
    );
  }

  /** The adopted home, only while it is still exactly the directory the owner adopted. */
  function pinnedHome(providerId: string, home: string, target: CodexLegacyTarget): string {
    let current: CodexLegacyTarget;
    try {
      current = pinCodexHome(home);
    } catch {
      throw new HostProjectionRefusal("target_changed");
    }
    if (!isDeepStrictEqual(current, target) || sharesCodexHome(current, otherHomes(providerId)))
      throw new HostProjectionRefusal("target_changed");
    return current.realpath;
  }

  function consumerFor(providerId: string, home: string): CodexSignInProjectionService {
    const existing = consumers.get(providerId);
    if (existing) return existing;
    const journal = join(home, CODEX_SIGNIN_STATE_DIRECTORY, "projection.json");
    const consumer = new CodexSignInProjectionService({
      authorize: async (value) => {
        const current = await authorize(value);
        if (value.access && current.excluded) throw new CodexSignInDeliveryError();
      },
      read: () => {
        const value = readClaudeSetupFile(journal);
        return value === null ? null : CodexSignInProjectionReceiptSchema.parse(value);
      },
      persist: (receipt) => writeClaudeSetupFile(journal, receipt),
      store: async (access) => writeCodexAccessProjection(home, access),
    });
    consumers.set(providerId, consumer);
    return consumer;
  }

  /** One writer per adopted legacy home. A home that changed gets no writer at all. */
  function legacyConsumerFor(providerId: string, home: string): CodexSignInProjectionService {
    const key = `legacy\n${providerId}\n${home}`;
    const existing = consumers.get(key);
    if (existing) return existing;
    const journal = join(home, CODEX_SIGNIN_STATE_DIRECTORY, "projection.json");
    const consumer = new CodexSignInProjectionService({
      authorize: async (value) => {
        if (!value.adoption) throw new CodexSignInDeliveryError();
        const current = await authorizeLegacy(value);
        if (value.access && current.excluded) throw new CodexSignInDeliveryError();
        if (pinnedHome(value.providerId, current.home, value.adoption.target) !== home)
          throw new HostProjectionRefusal("target_changed");
      },
      read: () => {
        const value = readClaudeSetupFile(journal);
        return value === null ? null : CodexSignInProjectionReceiptSchema.parse(value);
      },
      persist: (receipt) => writeClaudeSetupFile(journal, receipt),
      store: async (access, delivery) =>
        writeLegacyCodexProjection(home, access, {
          keepLocalSignIn: delivery.adoption?.keepLocalSignIn === true,
        }),
    });
    consumers.set(key, consumer);
    return consumer;
  }

  /** Token-bearing validation and I/O errors never reach the generic logger. */
  function refuse(res: Response, error: unknown): void {
    res.status(409).json({
      error: "Codex sign-in synchronization is pending.",
      ...(error instanceof HostProjectionRefusal ? { reason: error.reason } : {}),
    });
  }

  app.post(CODEX_SIGNIN_BINDING_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = CodexSignInBindingRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        // The Host grant stays the refresh source even when Host use is excluded.
        await authorize(parsed.data);
        const codexHome = accountHome(parsed.data.providerId);
        if (!isAbsolute(codexHome)) throw new CodexSignInDeliveryError();
        res.json({ providerId: parsed.data.providerId, codexHome });
      } catch (error) {
        refuse(res, error);
      }
    })();
  });

  app.post(CODEX_SIGNIN_LEASE_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = CodexSignInLeaseRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const leases = options.codexRefreshLeases;
        if (!leases) throw new CodexSignInDeliveryError();
        const request = parsed.data;
        // Release needs no fresh authority: it only ends a lease early.
        if (request.operation === "release") {
          leases.release(request.providerId, request.leaseId);
          res.json({ granted: false });
          return;
        }
        await authorize(request);
        accountHome(request.providerId);
        const lease = leases.acquire(request.providerId);
        res.json(lease ? { granted: true, ...lease } : { granted: false });
      } catch (error) {
        refuse(res, error);
      }
    })();
  });

  app.post(CODEX_SIGNIN_LEGACY_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = CodexSignInLegacyRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const request = parsed.data;
        if (request.operation === "forget-copy") {
          // Retention holds in every adoption state, also after a rebind or a changed home, so
          // the saved copy is found by the pinned directory's identity, not by today's binding.
          // Deleting this coordinator-owned backup cannot affect any sign-in in use.
          forgetLegacyCodexSignIn(await authorizeForget(request));
          res.json({ forgotten: true });
          return;
        }
        const { excluded, home } = await authorizeLegacy(request);
        if (request.operation === "pin") {
          if (excluded) throw new CodexSignInDeliveryError();
          const target = pinCodexHome(home);
          if (sharesCodexHome(target, otherHomes(request.providerId)))
            throw new CodexSignInDeliveryError();
          res.json({ target });
          return;
        }
        if (request.operation === "sessions") {
          res.json({ active: homeInUse(request.providerId, home) });
          return;
        }
        // Restore acts on Dev's own saved sign-in, also in an excluded binding.
        const pinned = pinnedHome(request.providerId, home, request.target);
        res.json(restoreLegacyCodexSignIn(pinned, Date.now()));
      } catch (error) {
        refuse(res, error);
      }
    })();
  });

  app.post(CODEX_SIGNIN_PROJECTION_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = CodexSignInProjectionDeliverySchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const delivery = parsed.data;
        if (delivery.adoption) {
          const { excluded, home } = await authorizeLegacy(delivery);
          if (delivery.access && excluded) throw new CodexSignInDeliveryError();
          const pinned = pinnedHome(delivery.providerId, home, delivery.adoption.target);
          const receipt = await legacyConsumerFor(delivery.providerId, pinned).apply(delivery);
          options.onApplied?.(delivery.providerId);
          res.json(receipt);
          return;
        }
        const { definition, excluded } = await authorize(delivery);
        if (delivery.access && excluded) throw new CodexSignInDeliveryError();
        // Retries reuse the same provider ID and home, including after a lost response.
        if (delivery.access)
          await createCodexAccount({
            paseoHome: options.paseoHome,
            store: options.store,
            creationId: definition.accountSetup!.creationId,
            name: definition.policy.label ?? "Codex",
          });
        const home = join(options.paseoHome, "codex-accounts", delivery.providerId);
        await mkdir(home, { recursive: true, mode: 0o700 });
        secureAccountHome(home);
        if (delivery.access) accountHome(delivery.providerId);
        const receipt = await consumerFor(delivery.providerId, home).apply(delivery);
        options.onApplied?.(delivery.providerId);
        res.json(receipt);
      } catch (error) {
        refuse(res, error);
      }
    })();
  });
}
