import type { MutableDaemonConfig, ProviderUsage } from "@getpaseo/protocol/messages";
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
  ready: readonly ProviderSnapshotEntry[],
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
 * The launch a daemon-created agent would use right now, or null when no provider is usable.
 * Reads cached usage; the Optimizer's own seeding refreshes it when connections change.
 */
export async function resolveDefaultLaunch(input: {
  providers: Pick<ProviderSnapshotManager, "listProviders">;
  readUsage: (options: { forceRefresh: boolean }) => Promise<{ providers: ProviderUsage[] }>;
  getSettings: () => MutableDaemonConfig;
}): Promise<Launch | null> {
  const entries = await input.providers.listProviders({ wait: false });
  const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
  if (ready.length === 0) return null;
  const usage = await input.readUsage({ forceRefresh: false });
  const settings = input.getSettings();
  const [best] = usableProviders(ready, usage.providers, settings);
  return best ? selectLaunch(best, settings) : null;
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
