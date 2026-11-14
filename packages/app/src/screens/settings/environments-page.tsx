import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { SettingsRevealContext } from "@/components/settings/reveal-context";
import { Text, View } from "react-native";
import { SettingsCard } from "@/components/settings";
import { SettingsDialogRow } from "@/components/settings/list-summary";
import { SettingsAdvancedGroup } from "@/components/settings/advanced-group";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { InstallationSettingsStatus } from "@/execution-installation/settings-status";
import { EnvironmentResourceExclusions } from "@/execution-installation/resource-exclusions";
import { useInstallationSettings } from "@/execution-installation/settings";
import { selectSettingsHost, useSettingsHostSelection } from "@/navigation/settings-presentation";
import type { HostProfile } from "@/types/host-connection";
import { formatConnectionStatus } from "@/utils/daemons";
import { settingsStyles } from "@/styles/settings";
import { HostSettingsPage } from "./host-page";
import { useSettingsFocus } from "./settings-focus";

/** How many shared resources an environment has turned off. */
function useExclusionCount(serverId: string): number {
  const { data } = useInstallationSettings();
  const exclusions = data?.settings?.resourceExclusions[serverId];
  if (!exclusions) return 0;
  return Object.values(exclusions).reduce<number>((count, value) => {
    if (value === true) return count + 1;
    return Array.isArray(value) ? count + value.length : count;
  }, 0);
}

function EnvironmentRow({
  host,
  open,
  onOpenChange,
  onHostRemoved,
}: {
  host: HostProfile;
  open: boolean;
  onOpenChange: (serverId: string, open: boolean) => void;
  onHostRemoved: () => void;
}) {
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const exclusions = useExclusionCount(host.serverId);
  const status = formatConnectionStatus(snapshot?.connectionStatus ?? "connecting");
  const hint =
    exclusions > 0
      ? `${status}. ${exclusions} ${exclusions === 1 ? "exception" : "exceptions"}`
      : status;
  const change = useCallback(
    (next: boolean) => onOpenChange(host.serverId, next),
    [host.serverId, onOpenChange],
  );
  const removed = useCallback(() => {
    change(false);
    onHostRemoved();
  }, [change, onHostRemoved]);
  return (
    <SettingsDialogRow
      label={host.label}
      hint={hint}
      open={open}
      onOpenChange={change}
      testID={`settings-environment-row-${host.serverId}`}
    >
      <View testID={`settings-environment-${host.serverId}`}>
        <HostSettingsPage serverId={host.serverId} onHostRemoved={removed} />
        {/* Exceptions are rare, so the long resource list stays closed until asked for. */}
        <SettingsAdvancedGroup
          title="Environment exceptions"
          testID={`settings-environment-exceptions-${host.serverId}`}
        >
          <InstallationSettingsStatus showStatus>
            <EnvironmentResourceExclusions serverId={host.serverId} />
          </InstallationSettingsStatus>
        </SettingsAdvancedGroup>
      </View>
    </SettingsDialogRow>
  );
}

/**
 * Every environment on one line with its connection status. Edit opens that environment's full
 * settings in a dialog, so nobody scrolls through each environment's details to reach the next
 * section. Self-contained, so a page can mount it as one group. A host overview address
 * (`/settings/hosts/<id>/host`) opens that environment's dialog.
 */
export function EnvironmentsSummary({ onHostRemoved }: { onHostRemoved: () => void }) {
  const hosts = useHosts();
  const focus = useSettingsFocus();
  const focusedId = focus?.kind === "environment" ? focus.serverId : null;
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusedId) return;
    selectSettingsHost(focusedId);
    setOpenId(focusedId);
  }, [focusedId]);
  // Every setting this pane indexes (name, color, badge, restart, update, remove, exceptions)
  // lives in an environment's dialog. A jump or search result that lands on one opens the
  // selected environment's dialog; Advanced groups inside open from the same reveal. Only a
  // jump made after mount counts, so reopening the page never opens a dialog by itself.
  const reveal = useContext(SettingsRevealContext);
  const selectedId = useSettingsHostSelection();
  const seenNonce = useRef(reveal.nonce);
  useEffect(() => {
    if (reveal.nonce === seenNonce.current) return;
    seenNonce.current = reveal.nonce;
    if (!reveal.targetSettingId || !reveal.pane || reveal.targetPane !== reveal.pane) return;
    const target = hosts.find((host) => host.serverId === selectedId) ?? hosts[0];
    if (target) setOpenId(target.serverId);
  }, [reveal.nonce, reveal.targetSettingId, reveal.targetPane, reveal.pane, hosts, selectedId]);
  const change = useCallback((serverId: string, open: boolean) => {
    if (open) selectSettingsHost(serverId);
    setOpenId((current) => {
      if (open) return serverId;
      return current === serverId ? null : current;
    });
  }, []);
  if (!hosts.length) {
    return <Text style={settingsStyles.rowHint}>Connect an environment to manage settings.</Text>;
  }
  return (
    <SettingsCard testID="settings-environment-scroll">
      {hosts.map((host) => (
        <EnvironmentRow
          key={host.serverId}
          host={host}
          open={openId === host.serverId}
          onOpenChange={change}
          onHostRemoved={onHostRemoved}
        />
      ))}
    </SettingsCard>
  );
}

/** The Environments pane body. Kept for the current catalog entry. */
export function EnvironmentsPane({ onHostRemoved }: { onHostRemoved: () => void }) {
  return <EnvironmentsSummary onHostRemoved={onHostRemoved} />;
}
