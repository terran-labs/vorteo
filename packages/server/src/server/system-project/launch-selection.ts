import type {
  AutomaticPrimary,
  DaemonPrimaryConnection,
  MutableDaemonConfig,
  ProviderUsage,
} from "@getpaseo/protocol/messages";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import { resolveProviderType, sharedProfileId } from "@getpaseo/protocol/provider-preferences";

import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import { launchCodexHome } from "../agent/create-agent/create.js";
import { claudeConfigDir } from "../agent/providers/claude/project-dir.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";

/** A provider and, when one applies, the profile a daemon-created agent launches with. */
export interface Launch {
  provider: string;
  profileId?: string;
}

/** Ready providers grouped by what their usage reading says about the sign in. */
export interface ProviderGroups {
  /** The reading shows a working sign in. */
  signedIn: string[];
  /** The daemon reads no usage for these. */
  unmetered: string[];
  /**
   * The reading is unavailable without asking for a new sign in, and that lasts: a setup-token
   * connection that has never hit a limit, a saved sign-in the CLI refreshes on its next run,
   * or a sign-in the provider refuses only to the usage API. They may well launch.
   */
  unconfirmed: string[];
  /** The reading failed, as a rate limit or network error does; the next reading may settle. */
  failing: string[];
  /** The reading asks for a new sign in, or no credentials exist at all. */
  signedOut: string[];
}

export function classifyProviders(
  ready: readonly Pick<ProviderSnapshotEntry, "provider">[],
  usage: readonly ProviderUsage[],
): ProviderGroups {
  const groups: ProviderGroups = {
    signedIn: [],
    unmetered: [],
    unconfirmed: [],
    failing: [],
    signedOut: [],
  };
  for (const entry of ready) {
    const reading = usage.find((item) => item.providerId === entry.provider);
    if (!reading) groups.unmetered.push(entry.provider);
    else if (reading.authRecovery || reading.credentialsMissing)
      groups.signedOut.push(entry.provider);
    else if (reading.status === "available") groups.signedIn.push(entry.provider);
    else if (reading.status === "error") groups.failing.push(entry.provider);
    else groups.unconfirmed.push(entry.provider);
  }
  return groups;
}

/**
 * Providers that can run a daemon-created agent, best first. A Claude or Codex connection
 * whose usage reading shows a working sign in comes first; a ready provider the daemon reads
 * no usage for comes next; a ready one whose reading shows no sign in, or that has no
 * credentials, is left out. Readings that are unavailable or failed without asking for a sign
 * in are left out too unless `includeUnconfirmed` is set, which the primary connection uses so
 * that such a reading never blocks it. The installation's default provider leads within each
 * group.
 */
export function usableProviders(
  ready: readonly Pick<ProviderSnapshotEntry, "provider">[],
  usage: readonly ProviderUsage[],
  settings: MutableDaemonConfig,
  options: { includeUnconfirmed?: boolean } = {},
): string[] {
  const groups = classifyProviders(ready, usage);
  const preferred = settings.sharedProviderPreferences?.defaultProvider;
  const byDefault = (left: string, right: string) =>
    Number(right === preferred) - Number(left === preferred);
  return [
    ...groups.signedIn.sort(byDefault),
    ...groups.unmetered.sort(byDefault),
    ...(options.includeUnconfirmed
      ? [...groups.unconfirmed.sort(byDefault), ...groups.failing.sort(byDefault)]
      : []),
  ];
}

/**
 * The account's default workflow when its provider type has one, then the default local
 * profile for that provider, then the provider's own defaults.
 */
export function selectLaunch(provider: string, settings: MutableDaemonConfig): Launch {
  const providerType = safeProviderType(provider, settings);
  const workflowId =
    settings.sharedProviderPreferences?.providers[providerType]?.defaultWorkflowId ?? null;
  if (workflowId) return { provider, profileId: sharedProfileId(providerType, workflowId) };
  const profile = settings.agentProfiles?.find(
    (candidate) => candidate.isDefault && candidate.provider === provider,
  );
  return profile ? { provider, profileId: profile.id } : { provider };
}

/** Launches to try in order: the selected profile, then the bare provider if a profile fails. */
export function launchAttempts(launch: Launch): Launch[] {
  return launch.profileId ? [launch, { provider: launch.provider }] : [launch];
}

function safeProviderType(provider: string, settings: MutableDaemonConfig): string {
  try {
    return resolveProviderType(provider, settings.providers ?? {});
  } catch {
    return provider;
  }
}

/**
 * The connection system threads launch with, once supported. An installation daemon uses the
 * coordinator's copy, where null means none is chosen. A standalone daemon uses its own choice;
 * undefined means it has not chosen yet. Unchosen means Automatic where that is supported.
 */
export function primaryConnection(
  settings: MutableDaemonConfig,
): DaemonPrimaryConnection | null | undefined {
  if (settings.sharedProviderPreferences?.installation)
    return settings.installationPrimaryConnection ?? null;
  return settings.primaryConnection;
}

/** The primary connection's launch: its own profile, else the provider's default profile. */
export function primaryLaunch(
  primary: DaemonPrimaryConnection,
  settings: MutableDaemonConfig,
): Launch {
  return primary.profileId
    ? { provider: primary.provider, profileId: primary.profileId }
    : selectLaunch(primary.provider, settings);
}

export interface DefaultLaunchInput {
  providers: Pick<ProviderSnapshotManager, "listProviders">;
  readUsage: (options: { forceRefresh: boolean }) => Promise<{ providers: ProviderUsage[] }>;
  getSettings: () => MutableDaemonConfig;
  /**
   * Re-reads whether the installation's coordinator owns the primary connection. A daemon that
   * moved back to an older coordinator then returns to the first usable launch.
   */
  refreshSupport?: () => Promise<void>;
}

/**
 * Whether this daemon launches system threads with the primary connection. A standalone daemon
 * owns the setting. An installation daemon waits for its coordinator's support marker, so an
 * older coordinator, which never projects a choice, keeps the earlier launch rule instead of
 * stalling the Optimizer and Factory.
 */
export function primaryConnectionSupported(settings: MutableDaemonConfig): boolean {
  return (
    !settings.sharedProviderPreferences?.installation ||
    settings.installationPrimaryConnectionSupported === true
  );
}

/**
 * Whether an unchosen primary connection means Automatic. A standalone daemon supports it
 * itself. An installation daemon needs its coordinator's marker: until then an unchosen
 * installation primary waits, because that coordinator still asks the owner to choose.
 */
export function automaticPrimarySupported(settings: MutableDaemonConfig): boolean {
  return (
    primaryConnectionSupported(settings) &&
    (!settings.sharedProviderPreferences?.installation ||
      settings.installationPrimaryConnectionAutomatic === true)
  );
}

/**
 * The lowest remaining percentage across an account's usage windows, or null when its reading
 * has no windows with a percentage, as an unmetered connection's has none.
 */
function remainingQuota(reading: ProviderUsage | undefined): number | null {
  const remaining: number[] = [];
  for (const window of reading?.windows ?? []) {
    if (typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct))
      remaining.push(window.remainingPct);
    else if (typeof window.usedPct === "number" && Number.isFinite(window.usedPct))
      remaining.push(100 - window.usedPct);
  }
  return remaining.length > 0 ? Math.min(...remaining) : null;
}

/** The nearest value of `key` in a provider's env along its `extends` chain. */
function inheritedEnv(
  settings: Pick<MutableDaemonConfig, "providers">,
  providerId: string,
  key: string,
): string | undefined {
  const visited = new Set<string>();
  for (let current: string | undefined = providerId; current && !visited.has(current); ) {
    visited.add(current);
    const parsed = ProviderOverrideSchema.safeParse(settings.providers?.[current]);
    if (!parsed.success) break;
    const value = parsed.data.env?.[key];
    if (value !== undefined) return value;
    current = parsed.data.extends;
  }
  return undefined;
}

/**
 * The credential home a provider launches with, as a real path: Codex's CODEX_HOME, resolved as
 * a launch resolves it, or Claude's config directory, which the provider env sets the same way.
 * Null for other provider types, which have no home to compare.
 */
function launchHomePath(
  provider: string,
  settings: MutableDaemonConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  const type = safeProviderType(provider, settings);
  if (type === "codex")
    return (
      launchCodexHome("codex", settings, provider, env) || join(env.HOME || homedir(), ".codex")
    );
  if (type === "claude")
    return inheritedEnv(settings, provider, "CLAUDE_CONFIG_DIR") || claudeConfigDir(env);
  return null;
}

/** Real paths, resolved without blocking the daemon; a missing folder keeps its absolute path. */
export type LaunchHomes = ReadonlyMap<string, string | null>;

/**
 * The real credential home of every provider that is switched off for Automatic, and of every
 * ready provider, but only when some provider is switched off: otherwise nothing is compared.
 */
async function resolveLaunchHomes(
  ready: readonly Pick<ProviderSnapshotEntry, "provider">[],
  settings: MutableDaemonConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LaunchHomes> {
  const switchedOff = Object.entries(settings.providers ?? {})
    .filter(([, provider]) => provider.automaticPrimary === false)
    .map(([provider]) => provider);
  if (switchedOff.length === 0) return new Map();
  const providers = [...new Set([...switchedOff, ...ready.map((entry) => entry.provider)])];
  const homes = await Promise.all(
    providers.map(async (provider): Promise<[string, string | null]> => {
      const home = launchHomePath(provider, settings, env);
      if (home === null) return [provider, null];
      try {
        return [provider, await realpath(home)];
      } catch {
        return [provider, resolve(home)];
      }
    }),
  );
  return new Map(homes);
}

/**
 * The accounts Automatic may pick, best first. Candidates are ready, on (an account excluded
 * from this environment is projected as off), not switched off for Automatic, and confirmed by
 * their usage reading: a working sign in, or no reading at all. A provider that launches with
 * the credential home of an account switched off is refused too, so a second entry for the same
 * account cannot bring it back. A reading that is unconfirmed, failing or signed out, or a window
 * with nothing left, never qualifies. Metered accounts come first, most remaining quota first;
 * then accounts without windows. Ties go to the installation's default provider, then to
 * provider order.
 *
 * "No reading" means the daemon has no usage fetcher for the provider: every fetcher adds an
 * entry to each usage list, a failed read included. Neither the provider definition nor the
 * snapshot says whether a provider is metered, so a list cached before an account was added can
 * briefly treat it as unmetered.
 *
 * TODO(#657): apply accountQuotaPolicy floors here once something enforces them; a pick below
 * its floor should stop being a candidate, like an exhausted window.
 */
export function rankAutomaticCandidates(
  ready: readonly Pick<ProviderSnapshotEntry, "provider">[],
  usage: readonly ProviderUsage[],
  settings: MutableDaemonConfig,
  homes: LaunchHomes,
): string[] {
  const groups = classifyProviders(ready, usage);
  const confirmed = new Set([...groups.signedIn, ...groups.unmetered]);
  const preferred = settings.sharedProviderPreferences?.defaultProvider;
  const switchedOff = Object.entries(settings.providers ?? {}).filter(
    ([, provider]) => provider.automaticPrimary === false,
  );
  const blockedHomes = new Set(switchedOff.flatMap(([provider]) => homes.get(provider) ?? []));
  const eligible = (provider: string) => {
    if (settings.providers?.[provider]?.automaticPrimary === false) return false;
    const home = blockedHomes.size > 0 ? homes.get(provider) : null;
    return home === null || home === undefined || !blockedHomes.has(home);
  };
  const candidates = ready.flatMap(({ provider }, order) => {
    if (!confirmed.has(provider) || !eligible(provider)) return [];
    const remaining = remainingQuota(usage.find((item) => item.providerId === provider));
    if (remaining !== null && remaining <= 0) return [];
    return [{ provider, remaining, order }];
  });
  candidates.sort((left, right) => {
    const metered = Number(right.remaining !== null) - Number(left.remaining !== null);
    if (metered !== 0) return metered;
    const quota = (right.remaining ?? 0) - (left.remaining ?? 0);
    if (quota !== 0) return quota;
    const byDefault = Number(right.provider === preferred) - Number(left.provider === preferred);
    return byDefault !== 0 ? byDefault : left.order - right.order;
  });
  return candidates.map((candidate) => candidate.provider);
}

/** Each daemon's last Automatic pick, keyed by its provider snapshot, so system threads stay put. */
const automaticPicks = new WeakMap<object, string>();

/** Automatic keeps its last pick while that account remains a candidate. */
function chooseAutomatic(ranked: readonly string[], last: string | undefined): string | null {
  if (last !== undefined && ranked.includes(last)) return last;
  return ranked[0] ?? null;
}

/**
 * The account Automatic launches on now, for display: the same choice a launch would make, without
 * recording it. Undefined when Automatic does not apply on this daemon; null when no account can
 * run system threads.
 */
export async function previewAutomaticPrimary(input: {
  providers: Pick<ProviderSnapshotManager, "listProviders">;
  usage: readonly ProviderUsage[];
  settings: MutableDaemonConfig;
}): Promise<AutomaticPrimary | null | undefined> {
  if (!automaticPrimarySupported(input.settings)) return undefined;
  const entries = await input.providers.listProviders({ wait: false });
  const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
  const homes = await resolveLaunchHomes(ready, input.settings);
  const pick = chooseAutomatic(
    rankAutomaticCandidates(ready, input.usage, input.settings, homes),
    automaticPicks.get(input.providers),
  );
  if (pick === null) return null;
  const label = ready.find((entry) => entry.provider === pick)?.label ?? pick;
  return { providerId: pick, label };
}

interface LaunchOptions {
  wait?: boolean;
  refreshUsage?: (readyKey: string) => boolean;
}

/**
 * Ready providers, optionally only one: `confirmed` can run a daemon-created agent, best first,
 * and `possible` adds those whose reading neither confirms nor refuses a sign in. `automatic`
 * is the account Automatic picks among them.
 */
async function readUsableProviders(
  input: DefaultLaunchInput,
  options: LaunchOptions,
  only?: string,
): Promise<{ confirmed: string[]; possible: string[]; automatic: string | null }> {
  const entries = await input.providers.listProviders({ wait: options.wait ?? false });
  const wanted = entries.filter((entry) => entry.enabled && (!only || entry.provider === only));
  const ready = wanted.filter((entry) => entry.status === "ready");
  if (ready.length === 0) return { confirmed: [], possible: [], automatic: null };
  const usage = await input.readUsage({
    forceRefresh: options.refreshUsage?.(ready.map((entry) => entry.provider).join(",")) ?? false,
  });
  const settings = input.getSettings();
  const homes = await resolveLaunchHomes(ready, settings);
  return {
    confirmed: usableProviders(ready, usage.providers, settings),
    possible: usableProviders(ready, usage.providers, settings, { includeUnconfirmed: true }),
    automatic: chooseAutomatic(
      rankAutomaticCandidates(ready, usage.providers, settings, homes),
      automaticPicks.get(input.providers),
    ),
  };
}

/**
 * The launch a daemon-created agent would use right now: the chosen primary connection, or
 * Automatic's pick while none is chosen. A chosen primary that is not usable gives null; it never
 * falls back to Automatic or another provider. Before Automatic is supported, an unchosen
 * primary gives null too; before the primary connection is supported, an installation daemon
 * keeps the earlier rule and launches with the first usable provider. Reads cached usage unless
 * asked; the Optimizer refreshes it when connections change.
 */
export async function resolveDefaultLaunch(
  input: DefaultLaunchInput,
  options: LaunchOptions = {},
): Promise<Launch | null> {
  await input.refreshSupport?.();
  // The reads below are asynchronous. If the owner changes the primary connection, or support
  // changes, meanwhile, select again once; a second change waits rather than launching on a
  // superseded choice.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = selectionState(input.getSettings());
    const launch = await selectDefaultLaunch(input, options);
    if (selectionState(input.getSettings()) === before) {
      if (launch?.automatic) automaticPicks.set(input.providers, launch.automatic);
      return launch?.launch ?? null;
    }
  }
  return null;
}

/** What a selection depends on: whether the primary connection applies, and which one it is. */
function selectionState(settings: MutableDaemonConfig): string {
  const primary = primaryConnection(settings);
  return JSON.stringify([
    primaryConnectionSupported(settings),
    automaticPrimarySupported(settings),
    primary === undefined ? "unset" : primary,
  ]);
}

async function selectDefaultLaunch(
  input: DefaultLaunchInput,
  options: LaunchOptions,
): Promise<{ launch: Launch; automatic?: string } | null> {
  const before = input.getSettings();
  if (!primaryConnectionSupported(before)) {
    // COMPAT(primaryConnection): the launch rule from before the primary connection existed.
    const [best] = (await readUsableProviders(input, options)).confirmed;
    return best ? { launch: selectLaunch(best, input.getSettings()) } : null;
  }
  const chosen = primaryConnection(before);
  if (chosen) {
    const read = await readUsableProviders(input, options, chosen.provider);
    return read.possible.length > 0 ? { launch: primaryLaunch(chosen, input.getSettings()) } : null;
  }
  // COMPAT(primaryConnectionAutomatic): an older coordinator still asks the owner to choose.
  if (!automaticPrimarySupported(before)) return null;
  const { automatic } = await readUsableProviders(input, options);
  return automatic ? { launch: selectLaunch(automatic, input.getSettings()), automatic } : null;
}

/**
 * The provider a profile launches with: a local profile's own provider, or the provider a
 * shared workflow profile ID names. Null when the profile is unknown.
 */
export function profileProvider(profileId: string, settings: MutableDaemonConfig): string | null {
  const local = settings.agentProfiles?.find((candidate) => candidate.id === profileId);
  if (local) return local.provider;
  const [kind, provider] = profileId.split("/");
  if ((kind === "shared-workflow" || kind === "shared-profile") && provider)
    return decodeURIComponent(provider);
  return null;
}
