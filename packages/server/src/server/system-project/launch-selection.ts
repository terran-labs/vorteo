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
 * Providers that can run a daemon-created agent, best first. A Claude or Codex connection
 * whose usage reading shows a working sign in comes first; a ready provider the daemon reads
 * no usage for comes next; a ready one whose reading shows no sign in is left out. The
 * installation's default provider leads within each group.
 */
export function usableProviders(
  ready: readonly Pick<ProviderSnapshotEntry, "provider">[],
  usage: readonly ProviderUsage[],
  settings: MutableDaemonConfig,
): string[] {
  const signedIn: string[] = [];
  const unmetered: string[] = [];
  for (const entry of ready) {
    const reading = usage.find((item) => item.providerId === entry.provider);
    if (!reading) unmetered.push(entry.provider);
    else if (reading.status === "available" && !reading.authRecovery) signedIn.push(entry.provider);
  }
  const preferred = settings.sharedProviderPreferences?.defaultProvider;
  const byDefault = (left: string, right: string) =>
    Number(right === preferred) - Number(left === preferred);
  return [...signedIn.sort(byDefault), ...unmetered.sort(byDefault)];
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

/** Ready providers that can run a daemon-created agent, best first, optionally only one. */
async function readUsableProviders(
  input: DefaultLaunchInput,
  options: LaunchOptions,
  only?: string,
): Promise<string[]> {
  const entries = await input.providers.listProviders({ wait: options.wait ?? false });
  const ready = entries.filter(
    (entry) => entry.enabled && entry.status === "ready" && (!only || entry.provider === only),
  );
  if (ready.length === 0) return [];
  const usage = await input.readUsage({
    forceRefresh: options.refreshUsage?.(ready.map((entry) => entry.provider).join(",")) ?? false,
  });
  return usableProviders(ready, usage.providers, input.getSettings());
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
  const before = input.getSettings();
  if (!primaryConnectionSupported(before)) {
    // COMPAT(primaryConnection): the launch rule from before the primary connection existed.
    const [best] = await readUsableProviders(input, options);
    return best ? selectLaunch(best, input.getSettings()) : null;
  }
  const chosen = primaryConnection(before);
  if (chosen === null) return null;
  const usable = await readUsableProviders(input, options, chosen?.provider);
  const settings = input.getSettings();
  if (chosen) return usable.length > 0 ? primaryLaunch(chosen, settings) : null;
  // Not chosen yet on a standalone daemon: adopt the only usable provider, once.
  if (!input.adoptPrimary || usable.length === 0) return null;
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
