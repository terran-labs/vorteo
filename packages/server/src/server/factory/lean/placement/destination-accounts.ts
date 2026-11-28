import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { InstallationAccountsAuthority, UsageList } from "../../project/account-choice.js";
import type { FactoryAccountSelection, FactoryAccountSnapshot } from "../account-policy.js";

export interface DevAccountFacts {
  accounts: {
    provider: string;
    aliasGroup: number | null;
    heldUntil: string | null;
    automaticEligible: boolean;
  }[];
}

export interface DevAccountSnapshot extends FactoryAccountSnapshot {
  serverId: string;
  placement: ReadonlyMap<string, string>;
  destinationAliases: ReadonlyMap<string, string | null>;
  destinationOptOuts: ReadonlySet<string>;
}

export interface AccountPlacementClient {
  getLastServerInfoMessage?(): {
    serverId: string;
    features?: { factoryDestinationAccountFacts?: boolean };
  } | null;
  getDaemonConfig(): Promise<{ config: MutableDaemonConfig }>;
  getProvidersSnapshot(): Promise<{ entries: FactoryAccountSnapshot["ready"] }>;
  listProviderUsage?(options: {
    placementFacts: true;
  }): Promise<UsageList & { placementFacts?: DevAccountFacts }>;
}

export class DevAccountUnavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DevAccountUnavailable";
  }
}

interface DestinationSource {
  hosts(): {
    use<T>(serverId: string, action: (client: AccountPlacementClient) => Promise<T>): Promise<T>;
  };
  serverId: string;
  boundDevServerId(): Promise<string | null>;
  readInstallationSettings(): Promise<InstallationAccountsAuthority | null>;
}

export async function readDevAccountSnapshot(
  source: DestinationSource,
  serverId: string,
): Promise<DevAccountSnapshot> {
  async function assertBinding() {
    if (serverId === source.serverId || (await source.boundDevServerId()) !== serverId) {
      throw new DevAccountUnavailable(
        "Factory's linked Dev destination is unavailable or changed.",
      );
    }
  }

  try {
    await assertBinding();
    const snapshot = await source.hosts().use(serverId, async (client) => {
      const info = client.getLastServerInfoMessage?.();
      if (info?.serverId !== serverId) {
        throw new DevAccountUnavailable("The Dev connection did not verify its server identity.");
      }
      const { listProviderUsage } = client;
      if (info.features?.factoryDestinationAccountFacts !== true || !listProviderUsage) {
        throw new DevAccountUnavailable("Update the linked Dev daemon to verify Factory accounts.");
      }
      const [{ config }, { entries }, { placementFacts, ...usage }] = await Promise.all([
        client.getDaemonConfig(),
        client.getProvidersSnapshot(),
        listProviderUsage.call(client, { placementFacts: true }),
      ]);
      if (client.getLastServerInfoMessage?.() !== info || !placementFacts) {
        throw new DevAccountUnavailable(
          "The Dev connection did not confirm account placement facts.",
        );
      }
      const authority = await source.readInstallationSettings();
      if (!authority || authority.serverId !== source.serverId) {
        throw new DevAccountUnavailable(
          "Factory could not verify the installation account definitions.",
        );
      }
      return accountSnapshot({
        serverId,
        settings: config,
        entries,
        usage,
        placementFacts,
        authority,
      });
    });
    await assertBinding();
    return snapshot;
  } catch (error) {
    if (error instanceof DevAccountUnavailable) throw error;
    throw new DevAccountUnavailable(
      "Factory could not read account facts from the linked Dev daemon.",
      error,
    );
  }
}

function accountSnapshot(input: {
  serverId: string;
  settings: MutableDaemonConfig;
  entries: Awaited<ReturnType<AccountPlacementClient["getProvidersSnapshot"]>>["entries"];
  usage: UsageList;
  placementFacts: DevAccountFacts;
  authority: InstallationAccountsAuthority;
}): DevAccountSnapshot {
  const { serverId, settings, entries, usage, placementFacts, authority } = input;
  const facts = new Map(placementFacts.accounts.map((row) => [row.provider, row]));
  const ids = new Set([
    ...entries.map(({ provider }) => provider),
    ...Object.keys(settings.providers ?? {}),
  ]);
  if (facts.size !== placementFacts.accounts.length || [...ids].some((id) => !facts.has(id))) {
    throw new DevAccountUnavailable(
      "The Dev daemon returned incomplete or duplicate account facts.",
    );
  }
  const { placement, definitions } = installationBindings(authority, serverId, ids);
  return {
    serverId,
    placement,
    settings,
    ready: entries,
    usage,
    installationDefinitionByProvider: Object.fromEntries(definitions),
    defaultProvider: settings.sharedProviderPreferences?.defaultProvider ?? null,
    priority: "normal",
    destinationAliases: new Map(
      placementFacts.accounts.map(({ provider, aliasGroup }) => [
        provider,
        aliasGroup === null ? null : String(aliasGroup),
      ]),
    ),
    destinationOptOuts: new Set(
      placementFacts.accounts.filter((row) => !row.automaticEligible).map((row) => row.provider),
    ),
    usageLimitedUntilByProvider: Object.fromEntries(
      placementFacts.accounts.map(({ provider, heldUntil }) => [provider, heldUntil]),
    ),
  };
}

function installationBindings(
  authority: InstallationAccountsAuthority,
  serverId: string,
  ids: ReadonlySet<string>,
) {
  const { providerDefinitions, resourceExclusions } = authority.settings;
  const excluded = new Set([
    ...(resourceExclusions[authority.serverId]?.providerIds ?? []),
    ...(resourceExclusions[serverId]?.providerIds ?? []),
  ]);
  const placement = new Map<string, string>();
  const definitions = new Map<string, string>();
  const localIds = new Set<string>();
  for (const definition of providerDefinitions ?? []) {
    const local = definition.bindings[authority.serverId];
    const remote = definition.bindings[serverId];
    if (definition.removed || !local || !remote || !ids.has(remote)) continue;
    if (localIds.has(local) || definitions.has(remote)) {
      throw new DevAccountUnavailable("The installation has ambiguous Dev account bindings.");
    }
    localIds.add(local);
    definitions.set(remote, definition.id);
    if (excluded.has(definition.id) || definition.policy.enabled === false) continue;
    placement.set(local, remote);
  }
  return { placement, definitions };
}

export function devAccountSnapshot(
  selection: Pick<FactoryAccountSelection, "serverId" | "role" | "providerType"> & {
    destination?: DevAccountSnapshot;
  },
  reviewerType: string,
): FactoryAccountSnapshot {
  const { destination, serverId, role, providerType } = selection;
  const isIssueRole = role === "lead" || role === "reviewer";
  if (!destination || destination.serverId !== serverId || !isIssueRole) {
    throw new DevAccountUnavailable("Factory could not verify this role's Dev account placement.");
  }
  if (role === "reviewer" && providerType !== reviewerType) {
    throw new DevAccountUnavailable(`Factory reviews require a ${reviewerType} account.`);
  }
  return {
    ...destination,
    reservedHeadroomPct: role === "lead" && providerType === reviewerType ? 10 : 0,
  };
}
