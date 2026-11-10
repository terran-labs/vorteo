import type {
  DaemonPrimaryConnection,
  MutableDaemonConfig,
  ProviderUsage,
} from "@getpaseo/protocol/messages";
import { resolveProviderType, sharedProfileId } from "@getpaseo/protocol/provider-preferences";

import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";

/** A provider and, when one applies, the profile a daemon-created agent launches with. */
export interface Launch {
  provider: string;
  profileId?: string;
}

/**
 * Ready providers grouped by what their usage reading says about the sign in. `uncertain`
 * holds providers whose reading failed or is unavailable without asking for a new sign in, such
 * as a transient error; only `signedOut` is known not to work.
 */
export function classifyProviders(
  ready: readonly Pick<ProviderSnapshotEntry, "provider">[],
  usage: readonly ProviderUsage[],
): { signedIn: string[]; unmetered: string[]; uncertain: string[]; signedOut: string[] } {
  const groups = {
    signedIn: [] as string[],
    unmetered: [] as string[],
    uncertain: [] as string[],
    signedOut: [] as string[],
  };
  for (const entry of ready) {
    const reading = usage.find((item) => item.providerId === entry.provider);
    if (!reading) groups.unmetered.push(entry.provider);
    else if (reading.authRecovery) groups.signedOut.push(entry.provider);
    else if (reading.status === "available") groups.signedIn.push(entry.provider);
    else groups.uncertain.push(entry.provider);
  }
  return groups;
}

/**
 * Providers that can run a daemon-created agent, best first. A Claude or Codex connection
 * whose usage reading shows a working sign in comes first; a ready provider the daemon reads
 * no usage for comes next; a ready one whose reading failed without asking for a sign in comes
 * last, so a transient usage error never blocks the primary connection; a ready one whose
 * reading shows no sign in is left out. The installation's default provider leads within each
 * group.
 */
export function usableProviders(
  ready: readonly Pick<ProviderSnapshotEntry, "provider">[],
  usage: readonly ProviderUsage[],
  settings: MutableDaemonConfig,
): string[] {
  const { signedIn, unmetered, uncertain } = classifyProviders(ready, usage);
  const preferred = settings.sharedProviderPreferences?.defaultProvider;
  const byDefault = (left: string, right: string) =>
    Number(right === preferred) - Number(left === preferred);
  return [...signedIn.sort(byDefault), ...unmetered.sort(byDefault), ...uncertain.sort(byDefault)];
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
 * undefined means it has not chosen yet.
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
   * Stores a standalone daemon's one-time choice: the only usable provider, or null when
   * several are usable and the owner has to choose. Without it nothing is adopted.
   */
  adoptPrimary?: (primary: DaemonPrimaryConnection | null) => void | Promise<void>;
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

interface LaunchOptions {
  wait?: boolean;
  refreshUsage?: (readyKey: string) => boolean;
}

/**
 * Ready providers that can run a daemon-created agent, best first, optionally only one.
 * `settling` is true while any of them is still loading or reads a usage error that does not
 * ask for a new sign in, so a one-time choice can wait for a settled answer.
 */
async function readUsableProviders(
  input: DefaultLaunchInput,
  options: LaunchOptions,
  only?: string,
): Promise<{ usable: string[]; settling: boolean }> {
  const entries = await input.providers.listProviders({ wait: options.wait ?? false });
  const wanted = entries.filter((entry) => entry.enabled && (!only || entry.provider === only));
  const loading = wanted.some((entry) => entry.status === "loading");
  const ready = wanted.filter((entry) => entry.status === "ready");
  if (ready.length === 0) return { usable: [], settling: loading };
  const usage = await input.readUsage({
    forceRefresh: options.refreshUsage?.(ready.map((entry) => entry.provider).join(",")) ?? false,
  });
  return {
    usable: usableProviders(ready, usage.providers, input.getSettings()),
    settling: loading || classifyProviders(ready, usage.providers).uncertain.length > 0,
  };
}

/**
 * The launch a daemon-created agent would use right now: the primary connection, or null while
 * none is chosen or the primary connection is not usable. Never falls back to another
 * provider once the primary connection is supported; before that, an installation daemon keeps
 * the earlier rule and launches with the first usable provider. Reads cached usage unless
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
    if (selectionState(input.getSettings()) === before) return launch;
  }
  return null;
}

/** What a selection depends on: whether the primary connection applies, and which one it is. */
function selectionState(settings: MutableDaemonConfig): string {
  const primary = primaryConnection(settings);
  return JSON.stringify([
    primaryConnectionSupported(settings),
    primary === undefined ? "unset" : primary,
  ]);
}

async function selectDefaultLaunch(
  input: DefaultLaunchInput,
  options: LaunchOptions,
): Promise<Launch | null> {
  const before = input.getSettings();
  if (!primaryConnectionSupported(before)) {
    // COMPAT(primaryConnection): the launch rule from before the primary connection existed.
    const [best] = (await readUsableProviders(input, options)).usable;
    return best ? selectLaunch(best, input.getSettings()) : null;
  }
  const chosen = primaryConnection(before);
  if (chosen === null) return null;
  const { usable, settling } = await readUsableProviders(input, options, chosen?.provider);
  const settings = input.getSettings();
  if (chosen) return usable.length > 0 ? primaryLaunch(chosen, settings) : null;
  // Not chosen yet on a standalone daemon: adopt the only usable provider, once, and only from a
  // settled reading, since a provider still loading after a restart may be usable too.
  if (!input.adoptPrimary || usable.length === 0 || settling) return null;
  if (primaryConnection(settings) !== undefined) return null;
  if (usable.length > 1) {
    await input.adoptPrimary(null);
    return null;
  }
  const adopted = { provider: usable[0]! };
  await input.adoptPrimary(adopted);
  return primaryLaunch(adopted, settings);
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
