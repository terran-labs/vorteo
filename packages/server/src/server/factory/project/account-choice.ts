import type { MutableDaemonConfig, ProviderUsage } from "@getpaseo/protocol/messages";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";
import type { ProjectFactoryAccountPick } from "@getpaseo/server/factory-project";

import type { ProviderSnapshotManager } from "../../agent/provider-snapshot-manager.js";
import { profileProvider, resolveDefaultLaunch } from "../../system-project/launch-selection.js";

/**
 * Picks the account a Factory worker, reviewer or planner starts on: among the ready accounts
 * of the stage profile's provider type, the one with the most fresh remaining quota. This
 * applies the rule in docs/agent-presets.md: unknown, stale and exhausted readings never
 * qualify. It is advisory at launch only; it does not switch running agents or pool accounts.
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
  /** Usage readings, refreshed now. */
  readUsage(): Promise<ProviderUsage[]>;
  /** The default launch's provider, used when the stage has no configured profile. */
  defaultProvider(): Promise<string | null>;
}

/** Ranks candidates by their lowest remaining window. Ties keep candidate order. */
export function rankAccounts(input: {
  candidates: readonly string[];
  usage: readonly ProviderUsage[];
  nowMs: number;
  avoid?: string;
}): { chosen: Considered | null; considered: Considered[] } {
  const considered = input.candidates.map((provider) =>
    judge(provider, input.usage, input.nowMs, input.avoid),
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

function judge(
  provider: string,
  usage: readonly ProviderUsage[],
  nowMs: number,
  avoid: string | undefined,
): Considered {
  const verdict = (value: Considered["verdict"], remainingPct: number | null = null) => ({
    provider,
    verdict: value,
    remainingPct,
  });
  if (provider === avoid) return verdict("avoided");
  const reading = usage.find((item) => item.providerId === provider);
  if (!reading || reading.status !== "available" || reading.authRecovery) return verdict("unknown");
  const fetchedAt = Date.parse(reading.fetchedAt ?? "");
  if (!Number.isFinite(fetchedAt) || nowMs - fetchedAt > ACCOUNT_READING_MAX_AGE_MS)
    return verdict("stale");
  const remaining = reading.windows.map((window) => window.remainingPct);
  if (remaining.length === 0 || remaining.some((value) => !Number.isFinite(value)))
    return verdict("unknown");
  const lowest = Math.min(...(remaining as number[]));
  return lowest > 0 ? verdict("qualifies", lowest) : verdict("exhausted", lowest);
}

/** Chooses an account for a stage profile, or reports why none qualifies. */
export async function chooseAccount(input: {
  accounts: FactoryAccounts;
  profileId: string | null;
  avoid?: string;
  nowMs: number;
}): Promise<{
  provider: string | null;
  remainingPct: number | null;
  considered: Considered[];
}> {
  const type = input.profileId
    ? input.accounts.providerType({ profileId: input.profileId })
    : await input.accounts
        .defaultProvider()
        .then((provider) => (provider ? input.accounts.providerType({ provider }) : null));
  if (!type) return { provider: null, remainingPct: null, considered: [] };
  const candidates = (await input.accounts.readyProviders()).filter(
    (provider) => input.accounts.providerType({ provider }) === type,
  );
  if (candidates.length === 0) return { provider: null, remainingPct: null, considered: [] };
  const ranked = rankAccounts({
    candidates,
    usage: await input.accounts.readUsage(),
    nowMs: input.nowMs,
    avoid: input.avoid,
  });
  return {
    provider: ranked.chosen?.provider ?? null,
    remainingPct: ranked.chosen?.remainingPct ?? null,
    considered: ranked.considered,
  };
}

/** The daemon's accounts: ready providers from the snapshot, usage refreshed on each pick. */
export function daemonFactoryAccounts(input: {
  providers: Pick<ProviderSnapshotManager, "listProviders">;
  readUsage: (options: { forceRefresh: boolean }) => Promise<{ providers: ProviderUsage[] }>;
  getSettings: () => MutableDaemonConfig;
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
    providerType({ provider, profileId }) {
      const account = profileId ? profileProvider(profileId, input.getSettings()) : provider;
      return account ? typeOf(account) : null;
    },
    async readUsage() {
      return (await input.readUsage({ forceRefresh: true })).providers;
    },
    async defaultProvider() {
      return (await resolveDefaultLaunch(input))?.provider ?? null;
    },
  };
}
