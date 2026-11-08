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
  /** The account an account-bound profile launches on. */
  profileAccount(profileId: string): string | null;
  /** Usage readings, refreshed now, with the time the list was read. */
  readUsage(): Promise<UsageList>;
  /** The default launch's provider, used when the stage has no configured profile. */
  defaultProvider(): Promise<string | null>;
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
  usage: UsageList,
  nowMs: number,
  avoid: string | undefined,
): Considered {
  const verdict = (value: Considered["verdict"], remainingPct: number | null = null) => ({
    provider,
    verdict: value,
    remainingPct,
  });
  if (provider === avoid) return verdict("avoided");
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

/** Chooses an account for a stage profile, or reports why none qualifies. */
export async function chooseAccount(input: {
  accounts: FactoryAccounts;
  profileId: string | null;
  avoid?: string;
  nowMs: number;
}): Promise<{
  provider: string | null;
  remainingPct: number | null;
  bound: boolean;
  considered: Considered[];
}> {
  const none = { provider: null, remainingPct: null, bound: false, considered: [] };
  if (input.profileId && isAccountBound(input.profileId)) {
    const provider = input.accounts.profileAccount(input.profileId);
    // The binding leaves no alternative to an avoided account, so nothing qualifies.
    if (provider !== null && provider === input.avoid)
      return {
        ...none,
        bound: true,
        considered: [{ provider, verdict: "avoided", remainingPct: null }],
      };
    return { ...none, provider, bound: provider !== null };
  }
  const type = input.profileId
    ? input.accounts.providerType({ profileId: input.profileId })
    : await input.accounts
        .defaultProvider()
        // The default launch reads usage too; a failed read falls back like any other.
        .catch(() => null)
        .then((provider) => (provider ? input.accounts.providerType({ provider }) : null));
  if (!type) return none;
  const candidates = (await input.accounts.readyProviders()).filter(
    (provider) => input.accounts.providerType({ provider }) === type,
  );
  if (candidates.length === 0) return none;
  // A failed usage read leaves every account unknown, so the configured default is used.
  const usage = await input.accounts
    .readUsage()
    .catch((): UsageList => ({ fetchedAt: "", providers: [] }));
  const ranked = rankAccounts({ candidates, usage, nowMs: input.nowMs, avoid: input.avoid });
  return {
    provider: ranked.chosen?.provider ?? null,
    remainingPct: ranked.chosen?.remainingPct ?? null,
    bound: false,
    considered: ranked.considered,
  };
}

/** The daemon's accounts: ready providers from the snapshot, usage refreshed on each pick. */
export function daemonFactoryAccounts(input: {
  providers: Pick<ProviderSnapshotManager, "listProviders">;
  readUsage: (options: {
    forceRefresh: boolean;
  }) => Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
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
  };
}
