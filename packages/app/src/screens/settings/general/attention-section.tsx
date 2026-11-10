import { useCallback, useRef } from "react";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { SettingsCollapsibleRow } from "@/components/settings/collapsible-row";
import { Button } from "@/components/ui/button";
import { useRestartsAwaitingApproval } from "@/execution-installation/panel";
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

interface AttentionItem {
  id: string;
  label: string;
  hint: string;
  pane: string;
  /** The row's button. Defaults to Review. */
  action?: string;
}

const NO_ENVIRONMENTS: never[] = [];

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Failing providers that are on. One the owner never enabled and the Host cannot use is off. */
function useProviderAttentionItems(): AttentionItem[] | null {
  const hosts = useHosts();
  const serverId = installationDefaultServerId(readExecutionInstallation()) ?? hosts[0]?.serverId;
  const { entries, isLoading, error: providerError } = useProvidersSnapshot(serverId ?? null);
  const shared = useInstallationSettings();
  const detection = useProviderDetection(shared.installation?.environments ?? NO_ENVIRONMENTS);
  // Null until the first answer; afterwards a refetch keeps the last answer on screen.
  const previous = useRef<AttentionItem[] | null>(null);
  if (!serverId) return [];
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
    label: `${entry.label ?? entry.provider} needs attention`,
    hint: entry.error ?? "This account cannot start agents.",
    pane: "accounts.providers",
  }));
  previous.current = items;
  return items;
}

const PRIMARY_MISSING: AttentionItem = {
  id: "primary-connection",
  label: "Choose a primary connection for system threads",
  hint: "The Optimizer and Factory wait until you choose one in Providers.",
  pane: "accounts.providers",
  action: "Open Providers",
};
const PRIMARY_UNAVAILABLE: AttentionItem = {
  ...PRIMARY_MISSING,
  label: "Your primary connection is unavailable. Choose another for system threads.",
  hint: "It is off, signed out, not ready or not connected on the Host or where Factory runs, so system threads there wait.",
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

function useAttentionItems(): AttentionItem[] | null {
  const restarts = useRestartsAwaitingApproval();
  const update = useVortonUpdate();
  const providerItems = useProviderAttentionItems();
  const primaryItem = usePrimaryConnectionItem();
  const items: AttentionItem[] = primaryItem ? [primaryItem] : [];
  if (restarts > 0) {
    items.push({
      id: "restarts",
      label: `${pluralize(restarts, "restart request")} waiting for approval`,
      hint: "Review the reason and approve or cancel in Maintenance.",
      pane: "maintenance.installation",
    });
  }
  const status = update.data?.status;
  if (status === "available" || status === "diverged") {
    items.push({
      id: "update",
      label: "Vorteo update available",
      hint: `${pluralize(update.data?.incomingCommits ?? 0, "new commit")} in ${
        update.data?.latestRelease ?? "main"
      }.`,
      pane: "maintenance.updates",
    });
  }
  return providerItems ? [...items, ...providerItems] : null;
}

function AttentionRow({
  item,
  onOpenPane,
}: {
  item: AttentionItem;
  onOpenPane: (pane: string) => void;
}) {
  const open = useCallback(() => onOpenPane(item.pane), [item.pane, onOpenPane]);
  return (
    <SettingsRow label={item.label} hint={item.hint} testID={`settings-attention-${item.id}`}>
      <Button variant="outline" size="sm" onPress={open}>
        {item.action ?? "Review"}
      </Button>
    </SettingsRow>
  );
}

/**
 * What needs the owner's action across Settings, at the top of General. It always renders one
 * row so General never shifts when checks finish: checking, all clear, the single item, or a
 * folded list the owner opens themselves.
 */
export function AttentionSection({ onOpenPane }: { onOpenPane: (pane: string) => void }) {
  const items = useAttentionItems();
  let row;
  if (items === null)
    row = <SettingsRow label="Checking..." hint="Looking for anything that needs you." />;
  else if (items.length === 0)
    row = <SettingsRow label="All clear" hint="Nothing needs your attention." />;
  else if (items.length === 1) row = <AttentionRow item={items[0]} onOpenPane={onOpenPane} />;
  else
    row = (
      <SettingsCollapsibleRow
        label={`${items.length} things need attention`}
        hint="Open to review each item."
      >
        {items.map((item) => (
          <AttentionRow key={item.id} item={item} onOpenPane={onOpenPane} />
        ))}
      </SettingsCollapsibleRow>
    );
  return (
    <SettingsSection title="Status" testID="settings-attention">
      <SettingsCard>{row}</SettingsCard>
    </SettingsSection>
  );
}
