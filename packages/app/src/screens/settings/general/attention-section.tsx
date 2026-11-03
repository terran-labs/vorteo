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
import { providersNeedingAttention } from "../shared-providers-model";
import { useProviderDetection } from "../use-provider-detection";

interface AttentionItem {
  id: string;
  label: string;
  hint: string;
  pane: string;
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

function useAttentionItems(): AttentionItem[] | null {
  const restarts = useRestartsAwaitingApproval();
  const update = useVortonUpdate();
  const providerItems = useProviderAttentionItems();
  const items: AttentionItem[] = [];
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
        Review
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
