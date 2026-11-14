import { useToast } from "@/contexts/toast-context";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { reportSyncError } from "@/components/settings/sync-error-notification";
import { CardHeaderStatus } from "@/components/ui/card-header-status";
import { ActionFooter, ActionFooterLeading } from "@/components/ui/action-footer";
import { useMutation } from "@tanstack/react-query";

import { readExecutionInstallation } from "@/execution-installation/policy";
import { ArrowDown, ArrowUp, Pencil, Plus, SquareTerminal, Trash2 } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import type { TerminalProfile, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  getTerminalProfileIcon,
  DEFAULT_TERMINAL_PROFILES,
} from "@getpaseo/protocol/terminal-profiles";
import { ProviderUsageSettingsSection } from "@/provider-usage/settings-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  ProfileDraft,
  TerminalProfileEditModal,
} from "@/screens/settings/terminal-profile-edit-modal";
import { startDesktopDaemon, stopDesktopDaemon } from "@/desktop/daemon/desktop-daemon";

import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import {
  useHostMutations,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { ProvidersSection } from "@/screens/settings/providers-section";
import { HostUsageSection } from "@/usage";
import { HostAppearanceSection } from "@/screens/settings/host-appearance-section";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsListSummary, useCloseSettingsDialog } from "@/components/settings/list-summary";
import { SettingsAdvancedGroup } from "@/components/settings/advanced-group";

import { settingsStyles } from "@/styles/settings";
import { isWeb } from "@/constants/platform";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isConnectionError, toErrorMessage } from "@/utils/error-messages";
import { useReportActionError } from "@/hooks/use-action-error";

import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { formatLatency } from "@/utils/latency";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { useProviderIcon } from "@/components/provider-icons";
import { BrowserToolsOptInCard } from "./browser-tools-card";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedProfilePencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedProfileSquareTerminal = withUnistyles(SquareTerminal);
const ThemedPlus = withUnistyles(Plus);

interface DynamicProviderIconProps {
  iconKey: string;
  size: number;
  color?: string;
}

function DynamicProviderIcon({ iconKey, size, color = "" }: DynamicProviderIconProps) {
  const Icon = useProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}

const ThemedDynamicProviderIcon = withUnistyles(DynamicProviderIcon);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const editProfileIcon = <ThemedProfilePencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeProfileIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;
const addProfileIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

function formatHostConnectionLabel(connection: HostConnection, t: TFunction): string {
  if (connection.type === "routed") return `Via ${connection.originServerId}`;
  if (connection.type === "relay") {
    return `${t("settings.host.badges.relay")} (${connection.relayEndpoint})`;
  }
  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return `${t("settings.host.badges.local")} (${connection.path})`;
  }
  if (connection.type === "remoteSsh") {
    return `${t("settings.host.badges.remoteSsh")} (${connection.host})`;
  }
  return `TCP (${connection.endpoint})`;
}

function useHostProfile(serverId: string): HostProfile | null {
  const daemons = useHosts();
  return daemons.find((entry) => entry.serverId === serverId) ?? null;
}

function HostNotFound() {
  const { t } = useTranslation();
  return (
    <View>
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.host.notFound")}</Text>
      </View>
    </View>
  );
}

function HostStatusBadges({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const snapshot = useHostRuntimeSnapshot(serverId);

  const connectionStatus = snapshot?.connectionStatus ?? "connecting";
  const statusLabel = formatConnectionStatus(connectionStatus);
  const statusTone = getConnectionStatusTone(connectionStatus);
  let statusVariant: StatusBadgeVariant = "muted";
  let statusDotColor = theme.colors.foregroundMuted;
  if (statusTone === "success") {
    statusVariant = "success";
    statusDotColor = theme.colors.statusDotSuccess;
  } else if (statusTone === "warning") {
    statusVariant = "warning";
    statusDotColor = theme.colors.statusDotWarning;
  } else if (statusTone === "error") {
    statusVariant = "error";
    statusDotColor = theme.colors.statusDotDanger;
  }
  const statusDotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: statusDotColor }],
    [statusDotColor],
  );
  const statusLeading = useMemo(() => <View style={statusDotStyle} />, [statusDotStyle]);

  return (
    <View style={styles.identityBadges} testID="host-page-identity">
      <StatusBadge label={statusLabel} variant={statusVariant} leading={statusLeading} />
    </View>
  );
}

/** `reserve` keeps the status line's height while empty, so a later error does not shift the page. */
function HostConnectionError({
  serverId,
  reserve = true,
}: {
  serverId: string;
  reserve?: boolean;
}) {
  const { t } = useTranslation();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const toast = useToast();
  useEffect(() => {
    reportSyncError(`host-connection:${serverId}`, snapshot?.lastError, () =>
      toast.error(toErrorMessage(snapshot?.lastError)),
    );
  }, [serverId, snapshot?.lastError, toast]);
  const message = [
    snapshot?.lastError,
    snapshot?.authFailureReason ? t("settings.host.password.guidance") : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (!reserve && !message) return null;
  return <SettingsStatusLine message={message} testID="host-connection-error" />;
}

/**
 * One environment's connections. `showTitle={false}` drops the "Connections" heading when the
 * caller already names the group, such as a per-environment subsection under Connections.
 */
export function HostConnectionsPage({
  serverId,
  showTitle = true,
}: {
  serverId: string;
  showTitle?: boolean;
}) {
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      {/* Untitled, the card sits right under the caller's heading: no empty status line. */}
      <HostConnectionError serverId={serverId} reserve={showTitle} />
      <ConnectionsSection host={host} showTitle={showTitle} />
    </View>
  );
}

// COMPAT(retiredPairingSettings): added in v155, retain until saved pair-device links are unsupported.
export function HostPairDevicePage({ serverId }: { serverId: string }) {
  return (
    <View>
      <Text style={settingsStyles.rowHint}>
        Device pairing has been retired. Connect this device through Tailscale and use the existing
        environment address and authentication.
      </Text>
      <HostConnectionsPage serverId={serverId} />
    </View>
  );
}

export function HostAgentsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const isConnected = useSettingsAvailable(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      {isConnected ? (
        <SettingsSection title={t("settings.hostSections.agents")}>
          {/* Vorteo saves through installation-aware shared settings; upstream's PaseoToolsCard serves its setup walkthrough. */}
          <InjectPaseoToolsCard serverId={serverId} />
          <BrowserToolsOptInCard serverId={serverId} />
          <AppendSystemPromptCard serverId={serverId} />
        </SettingsSection>
      ) : (
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("settings.host.agents.unavailable")}</Text>
        </View>
      )}
    </View>
  );
}

export function HostWorkspacesPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const isConnected = useSettingsAvailable(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      {isConnected ? (
        <SettingsSection title={t("settings.hostSections.workspaces")}>
          <AutoArchiveMergedWorkspacesCard serverId={serverId} />
        </SettingsSection>
      ) : (
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("settings.host.workspaces.unavailable")}</Text>
        </View>
      )}
    </View>
  );
}

export function HostProvidersPage({ serverId }: { serverId: string }) {
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <ProvidersSection serverId={serverId} />
    </View>
  );
}

export function HostUsagePage({ serverId }: { serverId: string }) {
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(serverId, {
    enabled: true,
  });
  const handleRefresh = useCallback(() => {
    void refreshProviderUsage();
  }, [refreshProviderUsage]);
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <ProviderUsageSettingsSection
        view={providerUsageView}
        onRefresh={handleRefresh}
        serverId={serverId}
      />
      <HostUsageSection serverId={serverId} />
    </View>
  );
}

export function HostSettingsPage({
  serverId,
  onHostRemoved,
}: {
  serverId: string;
  onHostRemoved?: () => void;
}) {
  const host = useHostProfile(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const installationOwned = Boolean(
    readExecutionInstallation()?.environments.some(
      (environment) => environment.serverId === serverId,
    ),
  );

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <HostStatusBadges serverId={serverId} />
      <HostConnectionError serverId={serverId} />

      <HostAppearanceSection host={host} />

      {/* Rarely needed and destructive, so it waits behind Advanced under its own Danger zone heading. */}
      <SettingsAdvancedGroup testID={`host-page-advanced-${serverId}`}>
        <RemoveHostSection
          host={host}
          isLocalDaemon={isLocalDaemon && !installationOwned}
          onRemoved={onHostRemoved}
        />
      </SettingsAdvancedGroup>
    </View>
  );
}

function ConnectionsSection({ host, showTitle }: { host: HostProfile; showTitle: boolean }) {
  const { t } = useTranslation();
  const { removeConnection } = useHostMutations();
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const probeByConnectionId = snapshot?.probeByConnectionId ?? new Map();
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{
    connectionId: string;
    title: string;
  } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);
  const removeConnectionHeader = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.connections.removeTitle") }),
    [t],
  );

  const handleRequestRemove = useCallback(
    (connection: HostConnection) => {
      setPendingRemoveConnection({
        connectionId: connection.id,
        title: formatHostConnectionLabel(connection, t),
      });
    },
    [t],
  );

  const handleCloseConfirm = useCallback(() => {
    if (isRemovingConnection) return;
    setPendingRemoveConnection(null);
  }, [isRemovingConnection]);

  const handleCancelConfirm = useCallback(() => {
    setPendingRemoveConnection(null);
  }, []);

  const handleConfirmRemove = useCallback(() => {
    if (!pendingRemoveConnection) return;
    const { connectionId } = pendingRemoveConnection;
    setIsRemovingConnection(true);
    void removeConnection(host.serverId, connectionId)
      .then(() => setPendingRemoveConnection(null))
      .catch((error) => {
        console.error("[HostPage] Failed to remove connection", error);
        Alert.alert(
          t("settings.host.connections.removeErrorTitle"),
          t("settings.host.connections.removeErrorMessage"),
        );
      })
      .finally(() => setIsRemovingConnection(false));
  }, [pendingRemoveConnection, removeConnection, host.serverId, t]);

  const modalFooter1 = useMemo(
    () => (
      <ActionFooter style={styles.confirmActions}>
        <ActionFooterLeading>
          <Button
            variant="destructive"
            onPress={handleConfirmRemove}
            disabled={isRemovingConnection}
            testID="remove-connection-confirm"
          >
            {t("settings.host.connections.removeAction")}
          </Button>
        </ActionFooterLeading>
        <Button variant="secondary" onPress={handleCancelConfirm} disabled={isRemovingConnection}>
          {t("common.actions.cancel")}
        </Button>
      </ActionFooter>
    ),
    [handleConfirmRemove, isRemovingConnection, t, handleCancelConfirm],
  );
  const content = (
    <>
      <View style={settingsStyles.card} testID="host-page-connections-card">
        {host.connections.map((conn, index) => {
          const probe = probeByConnectionId.get(conn.id);
          return (
            <ConnectionRow
              key={conn.id}
              connection={conn}
              showBorder={index > 0}
              latencyMs={probe?.status === "available" ? probe.latencyMs : undefined}
              latencyLoading={!probe || probe.status === "pending"}
              latencyError={probe?.status === "unavailable"}
              onRemove={handleRequestRemove}
            />
          );
        })}
      </View>

      {pendingRemoveConnection ? (
        <AdaptiveModalSheet
          header={removeConnectionHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-connection-confirm-modal"
          footer={modalFooter1}
        >
          <Text style={styles.confirmText}>
            {t("settings.host.connections.removeMessage", {
              name: pendingRemoveConnection.title,
            })}
          </Text>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
  // Without its heading the caller's section owns the spacing.
  return showTitle ? (
    <SettingsSection title={t("settings.host.connections.title")}>{content}</SettingsSection>
  ) : (
    content
  );
}

function ConnectionRow({
  connection,
  showBorder,
  latencyMs,
  latencyLoading,
  latencyError,
  onRemove,
}: {
  connection: HostConnection;
  showBorder: boolean;
  latencyMs: number | null | undefined;
  latencyLoading: boolean;
  latencyError: boolean;
  onRemove: (connection: HostConnection) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const title = formatHostConnectionLabel(connection, t);

  const latencyText = (() => {
    if (latencyLoading) return "...";
    if (latencyError) return t("settings.host.connections.timeout");
    if (latencyMs != null) return formatLatency(latencyMs);
    return "—";
  })();
  const latencyColor = latencyError ? theme.colors.palette.red[300] : theme.colors.foregroundMuted;

  const handlePressRemove = useCallback(() => {
    onRemove(connection);
  }, [onRemove, connection]);

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  const latencyTextStyle = useMemo(
    () => [styles.connectionLatency, { color: latencyColor }],
    [latencyColor],
  );
  const destructiveTextStyle = useMemo(
    () => ({ color: theme.colors.destructive }),
    [theme.colors.destructive],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Text style={latencyTextStyle}>{latencyText}</Text>
      <Button
        variant="ghost"
        textStyle={destructiveTextStyle}
        onPress={handlePressRemove}
        accessibilityLabel={`${t("settings.host.connections.removeAction")}: ${formatHostConnectionLabel(connection, t)}`}
      >
        {t("settings.host.connections.removeAction")}
      </Button>
    </View>
  );
}

function useSettingsAvailable(serverId: string): boolean {
  const connected = useHostRuntimeIsConnected(serverId);
  return (
    connected ||
    Boolean(
      readExecutionInstallation()?.environments.some(
        (environment) => environment.serverId === serverId,
      ),
    )
  );
}

function useSettingsMutation(serverId: string) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const reportActionError = useReportActionError();
  const mutation = useMutation({
    mutationFn: async (patch: MutableDaemonConfigPatch) => {
      const saved = await patchConfig(patch);
      if (!saved) throw new Error("The environment disconnected. Reconnect and retry.");
      return saved;
    },
    onError: (error) => {
      if (isConnectionError(error)) reportActionError(error);
    },
  });
  return { config, mutation };
}

/** Lost connections are reported as toasts, so only host rejections stay beside the setting. */
function SettingsSaveStatus({ error }: { error: Error | null }) {
  if (!error || isConnectionError(error)) return null;
  return <InlineAlert variant="error" description={toErrorMessage(error)} />;
}

function InjectPaseoToolsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useSettingsAvailable(serverId);
  const { config, mutation } = useSettingsMutation(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ mcp: { injectIntoAgents: next } });
    },
    [mutation],
  );

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-inject-mcp-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <View style={styles.savingHeader}>
            <Text style={[settingsStyles.rowTitle, styles.savingTitle]} numberOfLines={1}>
              {t("settings.host.orchestration.enableTools.title")}
            </Text>
            <CardHeaderStatus text={mutation.isPending ? "Saving..." : null} />
          </View>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.orchestration.enableTools.hint")}
          </Text>
        </View>
        <Switch
          value={config?.mcp.injectIntoAgents !== false}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel={t("settings.host.orchestration.enableTools.accessibilityLabel")}
        />
      </View>
      <SettingsSaveStatus error={mutation.error} />
    </View>
  );
}

function AutoArchiveMergedWorkspacesCard({ serverId }: { serverId: string }) {
  const isConnected = useSettingsAvailable(serverId);
  const { config, mutation } = useSettingsMutation(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ autoArchiveAfterMerge: next });
    },
    [mutation],
  );

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-auto-archive-merged-workspaces-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <View style={styles.savingHeader}>
            <Text style={[settingsStyles.rowTitle, styles.savingTitle]} numberOfLines={1}>
              Archive merged PR workspaces
            </Text>
            <CardHeaderStatus text={mutation.isPending ? "Saving..." : null} />
          </View>
          <Text style={settingsStyles.rowHint}>
            Automatically archive clean Vorteo workspaces after their pull request is merged
          </Text>
        </View>
        <Switch
          value={config?.autoArchiveAfterMerge === true}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel="Archive merged PR workspaces"
          testID="host-page-auto-archive-merged-workspaces-switch"
        />
      </View>
      <SettingsSaveStatus error={mutation.error} />
    </View>
  );
}

function EnableTerminalAgentHooksCard({ serverId }: { serverId: string }) {
  const isConnected = useSettingsAvailable(serverId);
  const { config, mutation } = useSettingsMutation(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ enableTerminalAgentHooks: next });
    },
    [mutation],
  );

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-terminal-agent-hooks-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <View style={styles.savingHeader}>
            <Text style={[settingsStyles.rowTitle, styles.savingTitle]} numberOfLines={1}>
              Enable terminal agent hooks
            </Text>
            <CardHeaderStatus text={mutation.isPending ? "Saving..." : null} />
          </View>
          <Text style={settingsStyles.rowHint}>
            Get notifications and status from terminal agents. This installs hooks in your agent
            config files.
          </Text>
        </View>
        <Switch
          value={config?.enableTerminalAgentHooks === true}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel="Enable terminal agent hooks"
          testID="host-page-terminal-agent-hooks-switch"
        />
      </View>
      <SettingsSaveStatus error={mutation.error} />
    </View>
  );
}

function AppendSystemPromptCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useSettingsAvailable(serverId);
  const { config, mutation } = useSettingsMutation(serverId);
  const persistedPrompt = config?.appendSystemPrompt ?? "";
  const showPromptPreview = persistedPrompt.trim().length > 0;
  const promptHint = t("settings.host.orchestration.systemPrompt.hint");
  const [draft, setDraft] = useState(persistedPrompt);
  const [isEditing, setIsEditing] = useState(false);
  const isSaving = mutation.isPending;
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.orchestration.systemPrompt.sheetTitle") }),
    [t],
  );

  const hasChanges = draft !== persistedPrompt;

  const handleOpen = useCallback(() => {
    mutation.reset();
    setDraft(persistedPrompt);
    setIsEditing(true);
  }, [persistedPrompt, mutation]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    setDraft(persistedPrompt);
    setIsEditing(false);
  }, [isSaving, persistedPrompt]);

  const handleSave = useCallback(() => {
    mutation.mutate({ appendSystemPrompt: draft }, { onSuccess: () => setIsEditing(false) });
  }, [draft, mutation]);

  const handleReset = useCallback(() => {
    setDraft(persistedPrompt);
  }, [persistedPrompt]);

  const modalFooter2 = useMemo(
    () => (
      <ActionFooter style={styles.appendPromptActions}>
        <Button
          variant="ghost"
          onPress={handleReset}
          disabled={!hasChanges || isSaving}
          testID="host-page-append-system-prompt-reset"
        >
          {t("settings.host.orchestration.systemPrompt.reset")}
        </Button>
        <Button
          variant="default"
          onPress={handleSave}
          disabled={!hasChanges || isSaving}
          testID="host-page-append-system-prompt-save"
        >
          {isSaving
            ? t("settings.host.orchestration.systemPrompt.saving")
            : t("settings.host.orchestration.systemPrompt.save")}
        </Button>
      </ActionFooter>
    ),
    [handleReset, hasChanges, isSaving, t, handleSave],
  );
  if (!isConnected) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-append-system-prompt-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.systemPrompt.title")}
            </Text>
            <Text
              style={settingsStyles.rowHint}
              numberOfLines={showPromptPreview ? 3 : undefined}
              ellipsizeMode="tail"
            >
              {showPromptPreview ? persistedPrompt : promptHint}
            </Text>
          </View>
          <Button
            variant="outline"
            onPress={handleOpen}
            testID="host-page-append-system-prompt-edit"
          >
            {t("settings.host.orchestration.systemPrompt.edit")}
          </Button>
        </View>
      </View>

      {isEditing ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={handleClose}
          testID="host-page-append-system-prompt-sheet"
          desktopMaxWidth={560}
          footer={modalFooter2}
        >
          <SettingsTextAreaCard
            testID="host-page-append-system-prompt-input"
            accessibilityLabel={t("settings.host.orchestration.systemPrompt.accessibilityLabel")}
            value={draft}
            onChangeText={setDraft}
            editable={!isSaving}
            placeholder={t("settings.host.orchestration.systemPrompt.placeholder")}
          />
          <SettingsSaveStatus error={mutation.error} />
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

function RemoveHostSection({
  host,
  isLocalDaemon,
  onRemoved,
}: {
  host: HostProfile;
  isLocalDaemon: boolean;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { removeHost } = useHostMutations();
  const { updateSettings } = useDesktopSettings();
  const { data: daemonStatusData, setStatus } = useDaemonStatus();
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const daemonStatus = daemonStatusData?.status ?? null;
  const stopsOwnedDaemon = isLocalDaemon && daemonStatus?.ownedByDesktop === true;
  const removeHostHeader = useMemo<SheetHeader>(
    () => ({
      title: stopsOwnedDaemon
        ? t("settings.host.daemon.remove.localConfirmTitle")
        : t("settings.host.daemon.remove.title"),
    }),
    [stopsOwnedDaemon, t],
  );

  const destructiveTextStyle = useMemo(
    () => ({ color: theme.colors.destructive }),
    [theme.colors.destructive],
  );

  const handleOpenConfirm = useCallback(() => setIsConfirming(true), []);
  const handleCloseConfirm = useCallback(() => {
    if (isRemoving) return;
    setIsConfirming(false);
  }, [isRemoving]);
  const handleCancel = useCallback(() => setIsConfirming(false), []);
  const rollbackLocalhostRemoval = useCallback(
    async (shouldRestartDaemon: boolean) => {
      await updateSettings({ daemon: { manageBuiltInDaemon: true } });
      if (!shouldRestartDaemon) {
        return;
      }
      setStatus(await startDesktopDaemon());
    },
    [setStatus, updateSettings],
  );
  const handleConfirmRemove = useCallback(() => {
    setIsRemoving(true);
    const remove = async () => {
      let didDisableDaemonManagement = false;
      let didStopDaemon = false;
      if (isLocalDaemon) {
        try {
          await updateSettings({ daemon: { manageBuiltInDaemon: false } });
          didDisableDaemonManagement = true;
          if (daemonStatus?.status === "running" && daemonStatus.ownedByDesktop) {
            setStatus(await stopDesktopDaemon("host_remove"));
            didStopDaemon = true;
          }
          await removeHost(host.serverId);
        } catch (error) {
          if (didDisableDaemonManagement) {
            try {
              await rollbackLocalhostRemoval(didStopDaemon);
            } catch (rollbackError) {
              console.error("[HostPage] Failed to roll back localhost removal", rollbackError);
            }
          }
          throw error;
        }
        return;
      }
      await removeHost(host.serverId);
    };
    void remove()
      .then(() => {
        setIsConfirming(false);
        onRemoved?.();
        return;
      })
      .catch((error) => {
        console.error("[HostPage] Failed to remove host", error);
        Alert.alert(
          t("settings.host.daemon.remove.errorTitle"),
          isLocalDaemon
            ? t("settings.host.daemon.remove.localErrorMessage")
            : t("settings.host.daemon.remove.errorMessage"),
        );
      })
      .finally(() => setIsRemoving(false));
  }, [
    daemonStatus,
    host.serverId,
    isLocalDaemon,
    onRemoved,
    removeHost,
    rollbackLocalhostRemoval,
    setStatus,
    t,
    updateSettings,
  ]);

  const removeIcon = useMemo(
    () => <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />,
    [theme.iconSize.sm, theme.colors.destructive],
  );

  const modalFooter3 = useMemo(
    () => (
      <ActionFooter style={styles.confirmActions}>
        <ActionFooterLeading>
          <Button
            variant="destructive"
            onPress={handleConfirmRemove}
            disabled={isRemoving}
            testID="remove-host-confirm"
          >
            {t("settings.host.connections.removeAction")}
          </Button>
        </ActionFooterLeading>
        <Button variant="secondary" onPress={handleCancel} disabled={isRemoving}>
          {t("common.actions.cancel")}
        </Button>
      </ActionFooter>
    ),
    [handleConfirmRemove, isRemoving, t, handleCancel],
  );
  return (
    <SettingsSection
      title={t("settings.host.daemon.dangerZone")}
      testID="host-page-remove-host-card"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {isLocalDaemon
                ? t("settings.host.daemon.remove.localTitle")
                : t("settings.host.daemon.remove.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {stopsOwnedDaemon
                ? t("settings.host.daemon.remove.localHint")
                : t("settings.host.daemon.remove.hint")}
            </Text>
          </View>
          <Button
            variant="outline"
            leftIcon={removeIcon}
            textStyle={destructiveTextStyle}
            onPress={handleOpenConfirm}
            testID="host-page-remove-host-button"
          >
            {t("settings.host.connections.removeAction")}
          </Button>
        </View>
      </View>

      {isConfirming ? (
        <AdaptiveModalSheet
          header={removeHostHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-host-confirm-modal"
          footer={modalFooter3}
        >
          <Text style={styles.confirmText}>
            {stopsOwnedDaemon
              ? t("settings.host.daemon.remove.localConfirmMessage")
              : t("settings.host.daemon.remove.confirmMessage", { name: host.label })}
          </Text>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Terminal Profiles
// ---------------------------------------------------------------------------

function generateProfileId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function parseArgsString(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EMPTY_PROFILE_DRAFT: ProfileDraft = { name: "", command: "", args: "" };

interface TerminalProfileRowProps {
  profile: TerminalProfile;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

const TERMINAL_PROFILE_NOUN = { one: "terminal profile", other: "terminal profiles" };

function TerminalProfileRow({
  profile,
  isFirst,
  isLast,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
}: TerminalProfileRowProps) {
  const { t } = useTranslation();

  // The editor is its own dialog, so a surrounding Manage dialog closes first.
  const closeDialog = useCloseSettingsDialog();
  const handleEdit = useCallback(() => {
    closeDialog();
    onEdit(profile.id);
  }, [closeDialog, onEdit, profile.id]);
  const handleRemove = useCallback(() => onRemove(profile.id), [onRemove, profile.id]);
  const handleMoveUp = useCallback(() => onMoveUp(profile.id), [onMoveUp, profile.id]);
  const handleMoveDown = useCallback(() => onMoveDown(profile.id), [onMoveDown, profile.id]);

  const commandText =
    profile.args && profile.args.length > 0
      ? `${profile.command} ${profile.args.join(" ")}`
      : profile.command;

  const rowStyle = useMemo(
    () => [settingsStyles.row, !isFirst && settingsStyles.rowBorder, terminalProfileStyles.row],
    [isFirst],
  );

  const icon = getTerminalProfileIcon(profile);

  return (
    <View style={rowStyle} testID={`terminal-profile-row-${profile.id}`}>
      <View style={terminalProfileStyles.iconWrapper}>
        {icon ? (
          <ThemedDynamicProviderIcon
            iconKey={icon}
            size={ICON_SIZE.md}
            uniProps={mutedColorMapping}
          />
        ) : (
          <ThemedProfileSquareTerminal size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        )}
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {profile.name}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {commandText}
        </Text>
      </View>
      <View style={terminalProfileStyles.rowActions}>
        <Button
          variant="ghost"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={isFirst}
          accessibilityLabel={`${t("settings.host.terminalProfiles.moveUp")}: ${profile.name}`}
          testID={`terminal-profile-move-up-${profile.id}`}
        />
        <Button
          variant="ghost"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={isLast}
          accessibilityLabel={`${t("settings.host.terminalProfiles.moveDown")}: ${profile.name}`}
          testID={`terminal-profile-move-down-${profile.id}`}
        />
        <Button
          variant="ghost"
          leftIcon={editProfileIcon}
          onPress={handleEdit}
          accessibilityLabel={`${t("settings.host.terminalProfiles.editProfile")}: ${profile.name}`}
          testID={`terminal-profile-edit-${profile.id}`}
        />
        <Button
          variant="ghost"
          leftIcon={removeProfileIcon}
          onPress={handleRemove}
          accessibilityLabel={`${t("settings.host.terminalProfiles.remove")}: ${profile.name}`}
          testID={`terminal-profile-remove-${profile.id}`}
        />
      </View>
    </View>
  );
}

function TerminalProfilesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useSettingsAvailable(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [editingProfile, setEditingProfile] = useState<{
    id: string;
    draft: ProfileDraft;
  } | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Settings edits what is persisted, not the adopted view. Any save here
  // writes the whole list back, so resolving first would bake read-time prompt
  // adoption into the user's config the first time they reorder a row.
  const profiles = useMemo(
    () => (config ? (config.terminalProfiles ?? DEFAULT_TERMINAL_PROFILES) : null),
    [config],
  );

  const saveProfiles = useCallback(
    async (next: TerminalProfile[]) => {
      await patchConfig({ terminalProfiles: next });
    },
    [patchConfig],
  );
  const reportActionError = useReportActionError();
  const reportSaveError = useCallback(
    (error: unknown) => {
      if (isConnectionError(error)) reportActionError(error);
      else Alert.alert(t("common.errors.unableToSave"), toErrorMessage(error));
    },
    [reportActionError, t],
  );

  const handleAddOpen = useCallback(() => setIsAdding(true), []);
  const handleAddClose = useCallback(() => setIsAdding(false), []);

  const handleAddSave = useCallback(
    async (draft: ProfileDraft) => {
      const current = profiles ? [...profiles] : [];
      const next: TerminalProfile[] = [
        ...current,
        {
          id: generateProfileId(),
          name: draft.name,
          command: draft.command,
          args: parseArgsString(draft.args),
        },
      ];
      await saveProfiles(next);
      setIsAdding(false);
    },
    [profiles, saveProfiles],
  );

  const handleEditOpen = useCallback(
    (id: string) => {
      const profile = profiles?.find((p) => p.id === id);
      if (!profile) return;
      setEditingProfile({
        id,
        draft: {
          name: profile.name,
          command: profile.command,
          args: profile.args ? profile.args.join(" ") : "",
        },
      });
    },
    [profiles],
  );

  const handleEditClose = useCallback(() => setEditingProfile(null), []);

  const handleEditSave = useCallback(
    async (draft: ProfileDraft) => {
      if (!editingProfile || !profiles) return;
      const next: TerminalProfile[] = profiles.map((p) =>
        p.id === editingProfile.id
          ? {
              ...p,
              name: draft.name,
              command: draft.command,
              args: parseArgsString(draft.args),
            }
          : p,
      );
      await saveProfiles(next);
      setEditingProfile(null);
    },
    [editingProfile, profiles, saveProfiles],
  );

  const handleRemove = useCallback(
    (id: string) => {
      const profile = profiles?.find((p) => p.id === id);
      if (!profile) return;
      void confirmDialog({
        title: t("settings.host.terminalProfiles.removeConfirmTitle"),
        message: t("settings.host.terminalProfiles.removeConfirmMessage", {
          name: profile.name,
        }),
        confirmLabel: t("settings.host.terminalProfiles.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed || !profiles) return;
        try {
          await saveProfiles(profiles.filter((p) => p.id !== id));
        } catch (error) {
          reportSaveError(error);
        }
        return;
      });
    },
    [profiles, saveProfiles, reportSaveError, t],
  );

  // After a move, focus stays on the moved row's arrow (the other one at an end, where this
  // one disables) and its new position is announced through a mounted live region.
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const settleMove = useCallback(
    (profile: TerminalProfile, index: number, count: number, direction: "up" | "down") => {
      setMoveAnnouncement(`${profile.name} moved to position ${index + 1} of ${count}`);
      if (!isWeb) return;
      const atEnd = direction === "up" ? index === 0 : index === count - 1;
      const arrow = atEnd === (direction === "up") ? "down" : "up";
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            `[data-testid="terminal-profile-move-${arrow}-${profile.id}"]`,
          )
          ?.focus(),
      );
    },
    [],
  );

  const handleMoveUp = useCallback(
    async (id: string) => {
      if (!profiles) return;
      const index = profiles.findIndex((p) => p.id === id);
      if (index <= 0) return;
      const next = [...profiles];
      const [item] = next.splice(index, 1);
      next.splice(index - 1, 0, item);
      try {
        await saveProfiles(next);
        settleMove(item, index - 1, next.length, "up");
      } catch (error) {
        reportSaveError(error);
      }
    },
    [profiles, saveProfiles, reportSaveError, settleMove],
  );

  const handleMoveDown = useCallback(
    async (id: string) => {
      if (!profiles) return;
      const index = profiles.findIndex((p) => p.id === id);
      if (index < 0 || index >= profiles.length - 1) return;
      const next = [...profiles];
      const [item] = next.splice(index, 1);
      next.splice(index + 1, 0, item);
      try {
        await saveProfiles(next);
        settleMove(item, index + 1, next.length, "down");
      } catch (error) {
        reportSaveError(error);
      }
    },
    [profiles, saveProfiles, reportSaveError, settleMove],
  );

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        leftIcon={addProfileIcon}
        onPress={handleAddOpen}
        disabled={!isConnected || !profiles}
        accessibilityLabel={t("settings.host.terminalProfiles.addProfileTitle")}
        testID="terminal-profiles-add-button"
      />
    ),
    [handleAddOpen, isConnected, profiles, t],
  );

  if (!isConnected) {
    return (
      <View style={settingsStyles.card} testID="terminal-profiles-unavailable">
        <View style={terminalProfileStyles.emptyCard}>
          <Text style={terminalProfileStyles.emptyText}>
            {t("settings.host.terminalProfiles.unavailable")}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.host.terminalProfiles.sectionTitle")}
        trailing={addButton}
        testID="terminal-profiles-section"
      >
        <SettingsListSummary
          title={t("settings.host.terminalProfiles.sectionTitle")}
          count={profiles?.length ?? 0}
          noun={TERMINAL_PROFILE_NOUN}
          preview={profiles?.map((profile) => profile.name)}
          testID="terminal-profiles-summary"
        >
          <View style={settingsStyles.card} testID="terminal-profiles-card">
            {profiles && profiles.length > 0 ? (
              profiles.map((profile, index) => (
                <TerminalProfileRow
                  key={profile.id}
                  profile={profile}
                  isFirst={index === 0}
                  isLast={index === profiles.length - 1}
                  onEdit={handleEditOpen}
                  onRemove={handleRemove}
                  onMoveUp={handleMoveUp}
                  onMoveDown={handleMoveDown}
                />
              ))
            ) : (
              <View style={terminalProfileStyles.emptyCard}>
                <Text style={terminalProfileStyles.emptyText}>
                  {t("settings.host.terminalProfiles.emptyState")}
                </Text>
              </View>
            )}
          </View>
        </SettingsListSummary>
        <Text accessibilityLiveRegion="polite" aria-live="polite" style={styles.visuallyHidden}>
          {moveAnnouncement}
        </Text>
      </SettingsSection>

      <TerminalProfileEditModal
        visible={isAdding}
        title={t("settings.host.terminalProfiles.addProfileTitle")}
        initialDraft={EMPTY_PROFILE_DRAFT}
        onClose={handleAddClose}
        onSave={handleAddSave}
        testID="terminal-profile-edit-modal"
      />

      {editingProfile ? (
        <TerminalProfileEditModal
          visible
          title={t("settings.host.terminalProfiles.editProfileTitle")}
          initialDraft={editingProfile.draft}
          onClose={handleEditClose}
          onSave={handleEditSave}
        />
      ) : null}
    </>
  );
}

export function HostTerminalsPage({ serverId }: { serverId: string }) {
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <TerminalProfilesSection serverId={serverId} />
      {/* Hooks for terminal agents are set once, so they sit behind Advanced at the end. */}
      <SettingsAdvancedGroup testID="terminal-agents-advanced">
        <SettingsSection title="Terminal agents">
          <EnableTerminalAgentHooksCard serverId={serverId} />
        </SettingsSection>
      </SettingsAdvancedGroup>
    </View>
  );
}

const terminalProfileStyles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
    minHeight: 56,
  },
  iconWrapper: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

const styles = StyleSheet.create((theme) => ({
  // Read by screen readers, not shown.
  visuallyHidden: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
  savingHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  savingTitle: { maxWidth: "70%", flexShrink: 1 },
  updateFailure: {
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[4],
  },
  identityBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
    marginBottom: theme.spacing[6],
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  badgePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    maxWidth: 200,
  },
  badgeText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  connectionError: {
    marginBottom: theme.spacing[6],
  },
  connectionLatency: {
    fontSize: theme.fontSize.base,
    marginRight: theme.spacing[2],
  },
  confirmText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  confirmActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  appendPromptActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
