import { Text, View } from "react-native";
import { useCallback, useRef } from "react";
import { SettingsCard, SettingsSection } from "@/components/settings";
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
function useProviderAttentionItems(): AttentionItem[] {
  const hosts = useHosts();
  const serverId = installationDefaultServerId(readExecutionInstallation()) ?? hosts[0]?.serverId;
  const { entries } = useProvidersSnapshot(serverId ?? null);
  const shared = useInstallationSettings();
  const detection = useProviderDetection(shared.installation?.environments ?? NO_ENVIRONMENTS);
  const previous = useRef<AttentionItem[]>([]);
  if (!entries || !shared.data) return previous.current;
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

function useAttentionItems(): AttentionItem[] {
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
  return [...items, ...providerItems];
}

/** A single reserved row keeps General stable while attention checks refresh. */
export function AttentionSection({ onOpenPane }: { onOpenPane: (pane: string) => void }) {
  const items = useAttentionItems();
  const first = items[0];
  const open = useCallback(() => {
    if (first) onOpenPane(first.pane);
  }, [first, onOpenPane]);
  return (
    <SettingsSection title="Status" testID="settings-attention">
      <SettingsCard>
        <View style={reservedLayout1}>
          <Text numberOfLines={1} style={reservedLayout2}>
            {items.length ? items.map((item) => item.label).join(" · ") : "All clear"}
          </Text>
          {first ? (
            <Button variant="outline" size="sm" onPress={open}>
              Review
            </Button>
          ) : null}
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}

const reservedLayout1 = {
  height: 72,
  justifyContent: "center",
  overflow: "hidden",
  paddingHorizontal: 16,
  flexDirection: "row",
  alignItems: "center",
  gap: 12,
} as const;
const reservedLayout2 = { flex: 1 } as const;
