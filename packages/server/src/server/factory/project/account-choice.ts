import type { InstallationSettings } from "@getpaseo/protocol/installation-settings";
import type { MutableDaemonConfig, ProviderUsage } from "@getpaseo/protocol/messages";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";
import type { ProjectFactoryAccountPick } from "@getpaseo/server/factory-project";

import type { ProviderSnapshotEntry } from "../../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../../agent/provider-snapshot-manager.js";
import { profileProvider, resolveDefaultLaunch } from "../../system-project/launch-selection.js";

/**
 * Picks the account a Factory worker, reviewer or planner starts on: among the ready accounts
 * of the stage profile's provider type, the one with the most fresh remaining quota. This
 * applies the rule in docs/agent-presets.md: unknown, stale and exhausted readings never
 * qualify. It is advisory at launch only; it does not switch running agents or pool accounts.
 *
 * An agent bound for a connected host, such as Dev, starts on that host's own id for the same
 * installation account. Usage is per account, so this daemon's readings still rank it. Only
 * the installation's provider definitions prove two local ids are one account; matching ids
 * alone never do.
 */

/** A reading older than this is stale. Choosing refreshes usage first, so this is generous. */
export const ACCOUNT_READING_MAX_AGE_MS = 5 * 60 * 1000;

type Considered = ProjectFactoryAccountPick["considered"][number];

/** What the daemon knows about accounts; injected so tests need no real providers. */
export interface FactoryAccounts {
  /** Ready, enabled provider ids (accounts), the installation's default first. */
  readyProviders(): Promise<string[]>;
  /** The provider type an account or profile launches as, such as "codex". */
  providerType(providerOrProfile: { provider?: string; profileId?: string }): string | null;
  /** The account an account-bound profile launches on. */
  profileAccount(profileId: string): string | null;
  /** Usage readings, refreshed now, with the time the list was read. */
  readUsage(): Promise<UsageList>;
  /** The default launch's provider, used when the stage has no configured profile. */
  defaultProvider(): Promise<string | null>;
  /**
   * For each local account that a connected host has as the same installation account, ready
   * and enabled there, that host's local id. Rejects with FactoryDestinationUnreadableError
   * when the host or the installation's settings cannot be read.
   */
  destinationAccounts(serverId: string): Promise<Map<string, string>>;
}

/** A connected host whose accounts cannot be read. No account is picked for it. */
export class FactoryDestinationUnreadableError extends Error {
  constructor(
    readonly serverId: string,
    cause: unknown,
  ) {
    super(
      `Cannot read the accounts of host ${serverId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "FactoryDestinationUnreadableError";
  }
}

/** A stage profile bound to one account, which cannot launch on another host. */
export class FactoryBoundProfileError extends Error {
  constructor(
    readonly profileId: string,
    readonly serverId: string,
  ) {
    super(
      `Profile ${profileId} is bound to one account and cannot launch on host ${serverId}. Configure the stage with a shared-profile/<type>/<workflow> profile.`,
    );
    this.name = "FactoryBoundProfileError";
  }
}

/** The part of a connected host's client that reading its accounts needs. */
export interface DestinationClient {
  getDaemonConfig(): Promise<{ config: Pick<MutableDaemonConfig, "providers"> }>;
  getProvidersSnapshot(): Promise<{
    entries: Pick<ProviderSnapshotEntry, "provider" | "enabled" | "status">[];
  }>;
}

/** Routes a call to a connected host, as connected-host tools do. */
export interface DestinationHosts {
  use<T>(serverId: string, action: (client: DestinationClient) => Promise<T>): Promise<T>;
}

/**
 * The installation's provider definitions as this daemon's settings authority returns them.
 * Bindings are keyed by each environment daemon's own server id: the coordinator writes them
 * over connections that refuse any daemon reporting a different id.
 */
export interface InstallationAccountsAuthority {
  /** This daemon's server id in the installation. */
  serverId: string;
  settings: Pick<InstallationSettings, "providerDefinitions" | "resourceExclusions">;
}

/**
 * Maps local accounts to a connected host's ready, enabled ones. With installation settings,
 * one definition, not removed and not excluded for that host, must bind both ids. Without
 * them, only a shared installation account id links two entries. An account excluded on that
 * host is also projected there as disabled, so it drops out either way.
 */
export async function readDestinationAccounts(input: {
  hosts: () => DestinationHosts;
  serverId: string;
  authority: InstallationAccountsAuthority | null;
  localProviders: MutableDaemonConfig["providers"];
}): Promise<Map<string, string>> {
  const { serverId } = input;
  const destination = await input
    .hosts()
    .use(serverId, async (client) => {
      const [{ config }, snapshot] = await Promise.all([
        client.getDaemonConfig(),
        client.getProvidersSnapshot(),
      ]);
      return { config, snapshot };
    })
    .catch((error: unknown) => {
      throw new FactoryDestinationUnreadableError(serverId, error);
    });
  const ready = new Set(
    destination.snapshot.entries
      .filter((entry) => entry.enabled && entry.status === "ready")
      .map((entry) => entry.provider),
  );
  return input.authority
    ? definedAccounts(input.authority, serverId, ready)
    : sharedAccountIds(input.localProviders, destination.config.providers, ready);
}

/** Accounts one installation definition binds on both daemons. */
function definedAccounts(
  authority: InstallationAccountsAuthority,
  serverId: string,
  ready: ReadonlySet<string>,
): Map<string, string> {
  const accounts = new Map<string, string>();
  const excluded = authority.settings.resourceExclusions[serverId]?.providerIds ?? [];
  for (const definition of authority.settings.providerDefinitions ?? []) {
    const local = definition.bindings[authority.serverId];
    const remote = definition.bindings[serverId];
    if (
      definition.removed ||
      definition.policy.enabled === false ||
      excluded.includes(definition.id) ||
      !local ||
      !remote
    )
      continue;
    if (ready.has(remote) && !accounts.has(local)) accounts.set(local, remote);
  }
  return accounts;
}

/** Without installation settings, accounts that share an installation account id. */
function sharedAccountIds(
  local: MutableDaemonConfig["providers"],
  remote: MutableDaemonConfig["providers"],
  ready: ReadonlySet<string>,
): Map<string, string> {
  const remoteByAccount = new Map<string, string>();
  for (const id of ready) {
    const shared = remote?.[id]?.installationAccountId;
    if (shared && !remoteByAccount.has(shared)) remoteByAccount.set(shared, id);
  }
  const accounts = new Map<string, string>();
  for (const [id, provider] of Object.entries(local ?? {})) {
    const match = provider.installationAccountId
      ? remoteByAccount.get(provider.installationAccountId)
      : undefined;
    if (match) accounts.set(id, match);
  }
  return accounts;
}

/** Usage readings and when they were read; a reading without its own time takes this one. */
export interface UsageList {
  fetchedAt: string;
  providers: ProviderUsage[];
}

/** Ranks candidates by their lowest remaining window. Ties keep candidate order. */
export function rankAccounts(input: {
  candidates: readonly string[];
  usage: UsageList;
  nowMs: number;
  avoid?: ReadonlySet<string>;
}): { chosen: Considered | null; considered: Considered[] } {
  const considered = input.candidates.map((provider) =>
    judge(provider, input.usage, input.nowMs, input.avoid?.has(provider) ?? false),
  );
  let chosen: Considered | null = null;
  for (const item of considered)
    if (
      item.verdict === "qualifies" &&
      (chosen === null || item.remainingPct! > chosen.remainingPct!)
    )
      chosen = item;
  return { chosen, considered };
}

function judge(provider: string, usage: UsageList, nowMs: number, avoided: boolean): Considered {
  const verdict = (value: Considered["verdict"], remainingPct: number | null = null) => ({
    provider,
    verdict: value,
    remainingPct,
  });
  if (avoided) return verdict("avoided");
  const reading = usage.providers.find((item) => item.providerId === provider);
  if (!reading || reading.status !== "available" || reading.authRecovery) return verdict("unknown");
  // Readings often carry no time of their own; the list's time is when they were read, as
  // quota reserve polling also assumes.
  const fetchedAt = Date.parse(reading.fetchedAt ?? usage.fetchedAt);
  if (!Number.isFinite(fetchedAt) || nowMs - fetchedAt > ACCOUNT_READING_MAX_AGE_MS)
    return verdict("stale");
  const remaining = reading.windows.map((window) => window.remainingPct);
  if (remaining.length === 0 || remaining.some((value) => !Number.isFinite(value)))
    return verdict("unknown");
  const lowest = Math.min(...(remaining as number[]));
  return lowest > 0 ? verdict("qualifies", lowest) : verdict("exhausted", lowest);
}

/**
 * Only a canonical `shared-profile/<type>/<workflow>` profile, or no profile, can launch on
 * any account of its type. A local profile or an older `shared-workflow/<account>/...`
 * reference is bound to its own account, so that account is used as is, without ranking.
 */
export function isAccountBound(profileId: string | null): boolean {
  return profileId !== null && !profileId.startsWith("shared-profile/");
}

interface Choice {
  provider: string | null;
  remainingPct: number | null;
  bound: boolean;
  considered: Considered[];
}

const NONE: Choice = { provider: null, remainingPct: null, bound: false, considered: [] };

/** Where the agent starts: this daemon, or a connected host with its own ids for accounts. */
interface Placement {
  /** The account's id where the agent starts, or null when that host lacks it. */
  place(provider: string): string | null;
  /** A considered local account, named by its id where the agent starts. */
  name(item: Considered, placed: string): Considered;
}

async function placement(accounts: FactoryAccounts, serverId?: string): Promise<Placement> {
  if (!serverId) return { place: (provider) => provider, name: (item) => item };
  const destination = await accounts.destinationAccounts(serverId);
  return {
    place: (provider) => destination.get(provider) ?? null,
    name: (item, placed) => ({
      provider: placed,
      localProvider: item.provider,
      verdict: item.verdict,
      remainingPct: item.remainingPct,
    }),
  };
}

/**
 * Chooses an account for a stage profile, or reports why none qualifies. With a destination,
 * only accounts that host has ready qualify, the result names them by that host's ids, and
 * `avoid` may use either id. An unreadable destination rejects rather than falling back here,
 * and so does a profile bound to one account, which cannot launch on another host.
 */
export async function chooseAccount(input: {
  accounts: FactoryAccounts;
  profileId: string | null;
  avoid?: string;
  /** A connected host the agent starts on; absent means this daemon. */
  destination?: string;
  nowMs: number;
}): Promise<Choice> {
  if (input.profileId && isAccountBound(input.profileId)) {
    if (input.destination) throw new FactoryBoundProfileError(input.profileId, input.destination);
    return chooseBound(input.accounts.profileAccount(input.profileId), input.avoid);
  }
  const where = await placement(input.accounts, input.destination);
  const type = input.profileId
    ? input.accounts.providerType({ profileId: input.profileId })
    : await input.accounts
        .defaultProvider()
        // The default launch reads usage too; a failed read falls back like any other.
        .catch(() => null)
        .then((provider) => (provider ? input.accounts.providerType({ provider }) : null));
  if (!type) return NONE;
  // Each candidate local account, with its id where the agent starts.
  const placed = new Map<string, string>();
  for (const provider of await input.accounts.readyProviders()) {
    const id = where.place(provider);
    if (id !== null && input.accounts.providerType({ provider }) === type) placed.set(provider, id);
  }
  const candidates = [...placed.keys()];
  if (candidates.length === 0) return NONE;
  // A failed usage read leaves every account unknown, so the configured default is used.
  const usage = await input.accounts
    .readUsage()
    .catch((): UsageList => ({ fetchedAt: "", providers: [] }));
  // Several local aliases can name one account; avoiding it by either id avoids every alias.
  const avoided = input.avoid === undefined ? undefined : (where.place(input.avoid) ?? input.avoid);
  const avoid = new Set(
    candidates.filter((provider) => provider === input.avoid || placed.get(provider) === avoided),
  );
  const ranked = rankAccounts({ candidates, usage, nowMs: input.nowMs, avoid });
  return {
    provider: ranked.chosen ? (placed.get(ranked.chosen.provider) ?? null) : null,
    remainingPct: ranked.chosen?.remainingPct ?? null,
    bound: false,
    considered: ranked.considered.map((item) =>
      where.name(item, placed.get(item.provider) ?? item.provider),
    ),
  };
}

/**
 * A bound profile launches on its own account, unranked. The binding leaves no alternative to
 * an avoided account, so then nothing qualifies.
 */
function chooseBound(provider: string | null, avoid?: string): Choice {
  if (provider === null) return NONE;
  if (provider === avoid)
    return {
      ...NONE,
      bound: true,
      considered: [{ provider, verdict: "avoided", remainingPct: null }],
    };
  return { ...NONE, provider, bound: true };
}

/** The daemon's accounts: ready providers from the snapshot, usage refreshed on each pick. */
export function daemonFactoryAccounts(input: {
  providers: Pick<ProviderSnapshotManager, "listProviders">;
  readUsage: (options: {
    forceRefresh: boolean;
  }) => Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
  getSettings: () => MutableDaemonConfig;
  hosts: () => DestinationHosts;
  /** This daemon's server id. */
  serverId: string;
  /** The installation's settings authority, as provider removal reads it; null without one. */
  readInstallationSettings: () => Promise<InstallationAccountsAuthority | null>;
}): FactoryAccounts {
  const typeOf = (provider: string): string | null => {
    try {
      return resolveProviderType(provider, input.getSettings().providers ?? {});
    } catch {
      return null;
    }
  };
  return {
    async readyProviders() {
      const preferred = input.getSettings().sharedProviderPreferences?.defaultProvider;
      const entries = await input.providers.listProviders({ wait: false });
      return entries
        .filter((entry) => entry.enabled && entry.status === "ready")
        .map((entry) => entry.provider)
        .sort((left, right) => Number(right === preferred) - Number(left === preferred));
    },
    profileAccount(profileId) {
      return profileProvider(profileId, input.getSettings());
    },
    providerType({ provider, profileId }) {
      const account = profileId ? profileProvider(profileId, input.getSettings()) : provider;
      return account ? typeOf(account) : null;
    },
    readUsage() {
      return input.readUsage({ forceRefresh: true });
    },
    async defaultProvider() {
      return (await resolveDefaultLaunch(input))?.provider ?? null;
    },
    async destinationAccounts(serverId) {
      const authority = await input.readInstallationSettings().catch((error: unknown) => {
        throw new FactoryDestinationUnreadableError(serverId, error);
      });
      if (authority && authority.serverId !== input.serverId)
        throw new FactoryDestinationUnreadableError(
          serverId,
          new Error("the installation's settings name another daemon"),
        );
      return readDestinationAccounts({
        hosts: input.hosts,
        serverId,
        authority,
        localProviders: input.getSettings().providers,
      });
    },
  };
}
