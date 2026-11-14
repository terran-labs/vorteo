import { useRef } from "react";
import {
  installationDefaultServerId,
  readExecutionInstallation,
} from "@/execution-installation/policy";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHosts } from "@/runtime/host-runtime";
import { useVortonUpdate } from "@/vorton-updates/use-update";
import { useInstallationSettings } from "@/execution-installation/settings";
import {
  primaryConnectionAvailability,
  usePrimaryConnection,
} from "@/execution-installation/primary-connection";
import { useDaemonPrimaryConnection } from "@/hooks/use-daemon-primary-connection";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useFactoryServerIds } from "@/screens/factory/overview-sources";
import { providersNeedingAttention } from "../shared-providers-model";
import { useProviderDetection } from "../use-provider-detection";
import type { SystemHealthItem } from "./health-model";

/**
 * The System Health rows. Installation items come in from the caller, which already holds the
 * installation state; this module adds the provider, primary connection and update rows. The
 * Health list publishes those extra rows to `health-extras` for the sidebar button.
 */

/** One row of the health list: the problem, where it stands now, and where its fix lives. */
export interface AttentionItem {
  id: string;
  label: string;
  /** The current status, shown under the problem. */
  hint: string;
  pane: string;
  /** Catalog entry whose row Fix lands on, when one row owns the fix. */
  settingId?: string;
}

const NO_ENVIRONMENTS: never[] = [];

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Failing providers that are on. One the owner never enabled and the Host cannot use is off.
 * While settings are locked the shared provider settings cannot load, so this answers with no
 * rows instead of waiting forever; the list says what unlocking would add.
 */
function useProviderAttentionItems(locked: boolean): AttentionItem[] | null {
  const hosts = useHosts();
  const serverId = installationDefaultServerId(readExecutionInstallation()) ?? hosts[0]?.serverId;
  const { entries, isLoading, error: providerError } = useProvidersSnapshot(serverId ?? null);
  const shared = useInstallationSettings();
  const detection = useProviderDetection(shared.installation?.environments ?? NO_ENVIRONMENTS);
  // Null until the first answer; afterwards a refetch keeps the last answer on screen.
  const previous = useRef<AttentionItem[] | null>(null);
  if (!serverId || locked) return [];
  const waitingForSettings = shared.installation && !shared.data && !shared.error;
  const waitingForProviders = serverId && !entries && isLoading && !providerError;
  if (waitingForSettings || waitingForProviders) return previous.current;

  const items = providersNeedingAttention({
    entries: entries ?? [],
    serverId: serverId ?? "",
    definitions: shared.data?.settings?.providerDefinitions,
    sources: detection,
  }).map((entry) => ({
    id: `account:${entry.provider}`,
    label: `${entry.label ?? entry.provider} account`,
    hint: entry.error ?? "Cannot start agents.",
    pane: "accounts.providers",
  }));
  previous.current = items;
  return items;
}

const PRIMARY_MISSING: AttentionItem = {
  id: "primary-connection",
  label: "Choose a primary connection for system threads",
  hint: "Not chosen. The Optimizer and Factory wait until you choose one in Providers.",
  pane: "accounts.providers",
};
const PRIMARY_UNAVAILABLE: AttentionItem = {
  ...PRIMARY_MISSING,
  label: "Primary connection for system threads",
  hint: "Unavailable. It is off, signed out, not ready or not connected on the Host or where Factory runs, so system threads there wait.",
};

/** Local provider ids whose usage reading asks for a new sign-in or finds no credentials. */
function useSignedOut(serverId: string | null): Set<string> {
  const { view } = useProviderUsage(serverId, { enabled: Boolean(serverId) });
  const providers = view.kind === "ready" ? view.payload.providers : [];
  return new Set(
    providers
      .filter((usage) => usage.authRecovery || usage.credentialsMissing)
      .map((usage) => usage.providerId),
  );
}

type Availability = ReturnType<typeof primaryConnectionAvailability>;

function primaryAttention(
  primary: { loaded: boolean; primary: object | null | undefined },
  availability: () => Availability,
): AttentionItem | null {
  if (!primary.loaded) return null;
  if (!primary.primary) return PRIMARY_MISSING;
  return availability() === "unavailable" ? PRIMARY_UNAVAILABLE : null;
}

/**
 * The installation's primary connection, checked where system threads run: the Host for the
 * Optimizer, plus each environment with a running Factory. Each launches from its own copy.
 */
function useSharedPrimaryItem(): AttentionItem | null {
  const installation = readExecutionInstallation();
  const environments = installation?.environments ?? NO_ENVIRONMENTS;
  const shared = usePrimaryConnection();
  const settings = useInstallationSettings(shared.supported);
  const detection = useProviderDetection(environments);
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId;
  const devId = environments.find((environment) => environment.kind === "container")?.serverId;
  const hostSignedOut = useSignedOut(shared.loaded ? (hostId ?? null) : null);
  const devSignedOut = useSignedOut(shared.loaded ? (devId ?? null) : null);
  const factories = useFactoryServerIds(shared.loaded);
  const required = environments
    .filter((environment) => environment.kind === "host" || factories.has(environment.serverId))
    .map((environment) => environment.serverId);
  return primaryAttention(shared, () =>
    primaryConnectionAvailability({
      primary: shared.primary!,
      definitions: settings.data?.settings?.providerDefinitions ?? [],
      exclusions: settings.data?.settings?.resourceExclusions,
      required,
      sources: detection,
      signedOut: new Map([
        [hostId ?? "", hostSignedOut],
        [devId ?? "", devSignedOut],
      ]),
    }),
  );
}

/** A standalone daemon names its provider directly, so it reads as a one-environment catalog. */
function useStandalonePrimaryItem(): AttentionItem | null {
  const hosts = useHosts();
  const serverId = readExecutionInstallation() ? null : (hosts[0]?.serverId ?? null);
  const standalone = useDaemonPrimaryConnection(serverId);
  const local = useProvidersSnapshot(standalone.supported ? serverId : null);
  const signedOut = useSignedOut(standalone.loaded ? serverId : null);
  const provider = standalone.primary?.provider ?? "";
  return primaryAttention(standalone, () =>
    primaryConnectionAvailability({
      primary: { providerId: provider },
      definitions: [
        {
          id: provider,
          providerType: provider,
          bindings: { [serverId ?? ""]: provider },
          policy: {},
        },
      ],
      required: serverId ? [serverId] : [],
      sources: [{ serverId: serverId ?? "", entries: local.entries }],
      signedOut: new Map([[serverId ?? "", signedOut]]),
    }),
  );
}

/**
 * Asks for a primary connection while none is chosen, or for another one while the chosen one
 * cannot run anywhere. Nothing is ever switched for the owner. Silent until settings load.
 */
function usePrimaryConnectionItem(): AttentionItem | null {
  const shared = useSharedPrimaryItem();
  const standalone = useStandalonePrimaryItem();
  return shared ?? standalone;
}

/** Installation items as Health rows. */
export function installationHealthRows(items: readonly SystemHealthItem[]): AttentionItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    hint: item.status,
    pane: item.pane,
    settingId: item.settingId,
  }));
}

/**
 * Every Health row, or null while the first provider answer is pending. `locked` skips rows that
 * need owner access to know.
 */
export function useSystemHealthRows({
  installationItems,
  locked,
}: {
  installationItems: readonly SystemHealthItem[];
  locked: boolean;
}): AttentionItem[] | null {
  const update = useVortonUpdate();
  const providerItems = useProviderAttentionItems(locked);
  const primaryItem = usePrimaryConnectionItem();
  const items: AttentionItem[] = primaryItem ? [primaryItem] : [];
  items.push(...installationHealthRows(installationItems));
  const status = update.data?.status;
  if (status === "available" || status === "diverged") {
    items.push({
      id: "update",
      label: "Vorteo update",
      hint: `Available: ${pluralize(update.data?.incomingCommits ?? 0, "new commit")} in ${
        update.data?.latestRelease ?? "main"
      }.`,
      pane: "system.overview",
      settingId: "maintenance.updates.vorteo",
    });
  }
  return providerItems ? [...items, ...providerItems] : null;
}
