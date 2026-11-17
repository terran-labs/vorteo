import { useMutation } from "@tanstack/react-query";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useFetchQuery } from "@/data/query";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { CompactAccountButton } from "@/provider-usage/compact-account-button";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { ProviderUsage } from "@/provider-usage/types";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type AccessibilityActionEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { CAN_HOVER, hoverGroup, hoverStyle } from "@/styles/hover";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { settingsStyles } from "@/styles/settings";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useInstallationSettings } from "@/execution-installation/settings";
import { sharedCatalogProviderEnrollment } from "@/execution-installation/settings-policy";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildAcpProviderConfigPatch,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { ProviderCatalogList } from "@/components/provider-catalog-list";
import { useProviderIcon } from "@/components/provider-icons";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  canMakePrimary,
  confirmDisablePrimary,
  confirmPrimaryConnection,
} from "@/execution-installation/primary-connection";
import { useDaemonPrimaryConnection } from "@/hooks/use-daemon-primary-connection";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isConnectionError, toErrorMessage } from "@/utils/error-messages";
import { useReportActionError } from "@/hooks/use-action-error";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { UsageLimitResumeSwitch } from "@/usage-limit/account-switch";

type ProviderDefinition = ReturnType<typeof buildProviderDefinitions>[number];
type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

type StatusTone = "success" | "warning" | "danger" | "muted" | "loading";

interface ProviderStatus {
  tone: StatusTone;
  label: string;
  modelCount: number | null;
}

function getProviderStatus(
  status: string,
  enabled: boolean,
  modelCount: number,
  t: TFunction,
): ProviderStatus {
  if (!enabled)
    return { tone: "muted", label: t("settings.providers.statuses.disabled"), modelCount: null };
  if (status === "loading") {
    return { tone: "loading", label: t("settings.providers.statuses.loading"), modelCount: null };
  }
  if (status === "error") {
    return { tone: "danger", label: t("settings.providers.statuses.error"), modelCount: null };
  }
  if (status === "ready") {
    return {
      tone: "success",
      label: t("settings.providers.statuses.available"),
      modelCount: modelCount > 0 ? modelCount : null,
    };
  }
  return {
    tone: "warning",
    label: t("settings.providers.statuses.notInstalled"),
    modelCount: null,
  };
}

interface ProviderRowProps {
  usage: ProviderUsage | undefined;
  serverId: string;
  def: ProviderDefinition;
  entry: ProviderEntry;
  enabled: boolean;
  isToggling: boolean;
  isRemoving: boolean;
  canRemove: boolean;
  isFirst: boolean;
  isLast?: boolean;
  drag?: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
  canReorder?: boolean;
  reorderPending?: boolean;
  onPress: (providerId: string) => void;
  onToggleEnabled: (providerId: string, enabled: boolean) => void;
  onRemove: (providerId: string, providerLabel: string) => void;
  onRename: (provider: ProviderDefinition) => void;
  /** Whether this is the primary connection; null where the setting is unavailable. */
  primary: boolean | null;
  onMakePrimary?: (providerId: string, providerLabel: string) => void;
  /** Why the last on or off change failed, shown on the row until the next attempt. */
  actionError?: string | null;
  /** Moves the provider one place up (-1) or down (1) without dragging. */
  onMove?: (providerId: string, offset: -1 | 1) => void;
}

/** On web, describe the details button with the row's visible summary. */
function describedBy(providerId: string) {
  return isWeb ? ({ "aria-describedby": `provider-summary-${providerId}` } as object) : {};
}

const REORDER_ACTIONS = [
  { name: "moveUp", label: "Move up" },
  { name: "moveDown", label: "Move down" },
];

const SKELETON_ROW_KEYS = [0, 1, 2, 3].map((index) => `provider-skeleton-row-${index}`);

function ProviderRowsSkeleton() {
  const { t } = useTranslation();
  const pulse = useSkeletonPulse();
  return (
    <View
      style={settingsStyles.card}
      accessibilityLabel={t("settings.providers.loading")}
      testID="providers-skeleton"
    >
      {SKELETON_ROW_KEYS.map((key, index) => (
        <View
          key={key}
          style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder, styles.row]}
        >
          <View style={styles.rowContent}>
            <SkeletonPulse pulse={pulse} style={styles.skeletonIcon} />
            <SkeletonPulse pulse={pulse} style={styles.skeletonTitle} />
          </View>
          <SkeletonPulse pulse={pulse} style={styles.skeletonSwitch} />
        </View>
      ))}
    </View>
  );
}

function ProviderRow({
  usage,
  serverId,
  def,
  entry,
  enabled,
  isToggling,
  isRemoving,
  canRemove,
  isFirst,
  isLast = false,
  drag,
  dragHandleProps,
  canReorder,
  reorderPending,
  onPress,
  onToggleEnabled,
  onRemove,
  onRename,
  primary,
  onMakePrimary,
  onMove,
  actionError = null,
}: ProviderRowProps) {
  const handleReorderAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "moveUp") onMove?.(def.id, -1);
      else if (event.nativeEvent.actionName === "moveDown") onMove?.(def.id, 1);
    },
    [onMove, def.id],
  );
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const ProviderIcon = useProviderIcon(def.id, serverId);
  const providerError = providerErrorText(entry, enabled);
  const modelCount = filterSelectableModels(entry.models ?? null)?.length ?? 0;
  const needsCliUpdate = enabled && Boolean(entry.cliUpdate);
  const visibleStatus = useMemo<ProviderStatus>(() => {
    const status = getProviderStatus(entry.status, enabled, modelCount, t);
    return needsCliUpdate ? { ...status, tone: "warning", label: "CLI update needed" } : status;
  }, [entry.status, enabled, modelCount, t, needsCliUpdate]);

  const handlePress = useCallback(() => {
    onPress(def.id);
  }, [def.id, onPress]);
  // The controls are siblings of the details button, so presses no longer
  // need to stop propagation.
  const handleRename = useCallback(() => onRename(def), [def, onRename]);
  const handleMakePrimary = useCallback(
    () => onMakePrimary?.(def.id, def.label),
    [def.id, def.label, onMakePrimary],
  );
  const handleRemove = useCallback(
    () => onRemove(def.id, def.label),
    [def.id, def.label, onRemove],
  );
  const handleToggleValueChange = useCallback(
    (value: boolean) => {
      onToggleEnabled(def.id, value);
    },
    [def.id, onToggleEnabled],
  );
  const rowStyle = useMemo(
    () => [
      settingsStyles.row,
      styles.row,
      styles.stackedRow,
      isCompact && styles.compactRow,
      styles.rowHovered,
    ],
    [isCompact],
  );

  return (
    <View style={[styles.draggableRow, !isFirst && settingsStyles.rowBorder]}>
      {canReorder ? (
        <View
          {...dragHandleProps?.attributes}
          {...(!reorderPending ? dragHandleProps?.listeners : undefined)}
          ref={dragHandleProps?.setActivatorNodeRef}
          accessibilityLabel={`Reorder ${def.label}`}
          testID={`provider-drag-${def.id}`}
        >
          {/* On web the wrapper above is the one keyboard stop; native screen readers use the
              Move up and Move down actions instead of dragging. */}
          <Pressable
            onLongPress={drag}
            disabled={reorderPending}
            focusable={!isWeb}
            accessibilityActions={REORDER_ACTIONS}
            onAccessibilityAction={handleReorderAction}
            // On web the wrapper is already the button; a second one inside it is invalid HTML.
            accessibilityRole={isWeb ? undefined : "button"}
            accessibilityLabel={`Reorder ${def.label}`}
            accessibilityHint="Long press, then drag to change the order"
            style={styles.dragHandle}
          >
            <GripVertical size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      ) : null}
      {/* Controls sit beside the details button, not inside it: a button
          inside a button is invalid HTML and breaks keyboard focus. */}
      <View style={styles.rowStack}>
        <View style={rowStyle}>
          <Pressable
            style={[styles.rowContent, styles.rowContentGroup]}
            onPress={handlePress}
            accessibilityRole="button"
            accessibilityLabel={t("settings.providers.providerDetails", { name: def.label })}
            accessibilityHint={visibleStatus.label}
            // Web drops accessibilityHint, so the status, Primary badge and error text are tied
            // to the button as its description instead.
            {...describedBy(def.id)}
          >
            {/* On web the chevron inherits the details button's CSS hover color. */}
            <ChevronRight
              size={theme.iconSize.sm}
              color={isWeb ? "currentColor" : theme.colors.foregroundMuted}
            />
            <ProviderIcon size={theme.iconSize.md} color={theme.colors.foreground} />
            <View style={styles.textColumn} nativeID={`provider-summary-${def.id}`}>
              <View style={styles.titleRow}>
                <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                  {def.label}
                </Text>
                <PrimaryBadge primary={primary} providerId={def.id} />
                {!isCompact ? <Text style={styles.separator}>·</Text> : null}
                <StatusIndicator status={visibleStatus} compact={isCompact} />
              </View>
              <RowError actionError={actionError} providerError={providerError} />
            </View>
          </Pressable>
          <ProviderRowControls
            canReorder={canReorder}
            reorderPending={reorderPending}
            isFirst={isFirst}
            isLast={isLast}
            onMove={onMove}
            custom={entry.source === "custom"}
            canRemove={canRemove}
            isRemoving={isRemoving}
            isToggling={isToggling}
            enabled={enabled}
            serverId={serverId}
            def={def}
            usage={usage}
            onRename={handleRename}
            onRemove={handleRemove}
            onToggle={handleToggleValueChange}
            offersMakePrimary={canMakePrimary({
              primary,
              enabled,
              states: [{ kind: providerReadiness(entry, usage) }],
            })}
            onMakePrimary={handleMakePrimary}
          />
        </View>
        {enabled ? (
          <UsageLimitResumeSwitch
            serverId={serverId}
            providerId={def.id}
            providerLabel={def.label}
          />
        ) : null}
      </View>
    </View>
  );
}

/** The same rule as the shared providers page: ready and not waiting for a sign-in. */
function providerReadiness(entry: ProviderEntry, usage: ProviderUsage | undefined) {
  return entry.status === "ready" && !usage?.authRecovery ? "ready" : "attention";
}

function PrimaryBadge({ primary, providerId }: { primary: boolean | null; providerId: string }) {
  if (!primary) return null;
  return (
    <View testID={`provider-primary-${providerId}`}>
      <StatusBadge label="Primary" size="xs" variant="success" />
    </View>
  );
}

function providerErrorText(
  entry: { status: string; error?: string },
  enabled: boolean,
): string | null {
  const error = entry.error?.trim();
  return enabled && entry.status === "error" && error ? toErrorMessage(error) : null;
}

/** Errors show on every layout, without clamping; a failed change is announced. */
function RowError({
  actionError,
  providerError,
}: {
  actionError: string | null;
  providerError: string | null;
}) {
  if (actionError)
    return (
      <Text accessibilityRole="alert" style={settingsStyles.rowError}>
        {actionError}
      </Text>
    );
  return providerError ? <Text style={settingsStyles.rowError}>{providerError}</Text> : null;
}

/** Visible Move up and Move down buttons, so ordering never depends on dragging. */
function MoveButtons({
  id,
  label,
  pending,
  isFirst,
  isLast,
  onMove,
}: {
  id: string;
  label: string;
  pending: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove?: (providerId: string, offset: -1 | 1) => void;
}) {
  const up = useCallback(() => onMove?.(id, -1), [onMove, id]);
  const down = useCallback(() => onMove?.(id, 1), [onMove, id]);
  return (
    <>
      <Button
        variant="ghost"
        leftIcon={ArrowUp}
        onPress={up}
        disabled={pending || isFirst}
        accessibilityLabel={`Move ${label} up`}
        testID={`provider-move-up-${id}`}
      />
      <Button
        variant="ghost"
        leftIcon={ArrowDown}
        onPress={down}
        disabled={pending || isLast}
        accessibilityLabel={`Move ${label} down`}
        testID={`provider-move-down-${id}`}
      />
    </>
  );
}

function ProviderRowControls({
  canReorder = false,
  reorderPending = false,
  isFirst,
  isLast,
  onMove,
  custom,
  canRemove,
  isRemoving,
  isToggling,
  enabled,
  serverId,
  def,
  usage,
  onRename,
  onRemove,
  onToggle,
  offersMakePrimary,
  onMakePrimary,
}: {
  /** Where the host supports ordering, visible move buttons lead the controls. */
  canReorder?: boolean;
  reorderPending?: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove?: (providerId: string, offset: -1 | 1) => void;
  offersMakePrimary: boolean;
  onMakePrimary: () => void;
  custom: boolean;
  canRemove: boolean;
  isRemoving: boolean;
  isToggling: boolean;
  enabled: boolean;
  serverId: string;
  def: { id: string; label: string };
  usage: ProviderUsage | undefined;
  onRename: () => void;
  onRemove: () => void;
  onToggle: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[styles.trailingControls, styles.vortonTrailingControls]}>
      {canReorder ? (
        <MoveButtons
          id={def.id}
          label={def.label}
          pending={reorderPending}
          isFirst={isFirst}
          isLast={isLast}
          onMove={onMove}
        />
      ) : null}
      {offersMakePrimary ? (
        <CompactAccountButton
          onPress={onMakePrimary}
          accessibilityLabel={`Make ${def.label} primary`}
          testID={`provider-make-primary-${def.id}`}
        >
          Make primary
        </CompactAccountButton>
      ) : null}
      {custom ? (
        <>
          <CompactAccountButton
            onPress={onRename}
            disabled={isRemoving}
            accessibilityLabel={`Rename ${def.label}`}
            testID={`provider-rename-${def.id}`}
          >
            Rename
          </CompactAccountButton>
          {canRemove ? (
            <CompactAccountButton
              onPress={onRemove}
              disabled={isRemoving}
              loading={isRemoving}
              tone="danger"
              accessibilityLabel={`Delete ${def.label}`}
              testID={`provider-remove-${def.id}`}
            >
              Delete
            </CompactAccountButton>
          ) : null}
        </>
      ) : null}
      <ProviderReconnectControl
        serverId={serverId}
        providerId={def.id}
        name={def.label}
        usage={usage}
      />
      <Switch
        value={enabled}
        onValueChange={onToggle}
        disabled={isToggling || isRemoving}
        accessibilityLabel={t("settings.providers.enableProvider", { name: def.label })}
      />
    </View>
  );
}

function getDotColor(tone: StatusTone, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

function StatusIndicator({ status, compact }: { status: ProviderStatus; compact: boolean }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const dotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: getDotColor(status.tone, theme) }],
    [status.tone, theme],
  );

  return (
    <View style={styles.statusRow}>
      {status.tone === "loading" ? (
        <LoadingSpinner size={10} color={theme.colors.foregroundMuted} />
      ) : (
        <View style={dotStyle} />
      )}
      {/* The label always accompanies the dot, so status never rests on color alone. */}
      <Text style={styles.statusLabel} numberOfLines={1}>
        {status.label}
      </Text>
      {!compact && status.modelCount !== null ? (
        <>
          <Text style={styles.separator}>·</Text>
          <Text style={styles.statusLabel}>
            {status.modelCount === 1
              ? t("settings.providers.models.one")
              : t("settings.providers.models.many", { count: status.modelCount })}
          </Text>
        </>
      ) : null}
    </View>
  );
}

export interface ProvidersSectionProps {
  serverId: string;
  runtimeOnly?: boolean;
}

function ProviderCatalogInstallation({ serverId }: { serverId: string }) {
  const supportsHopliteProvider = useHostFeature(serverId, "hopliteProvider");
  const shared = useInstallationSettings();
  const client = useHostRuntimeClient(serverId);
  const { patchConfig } = useDaemonConfig(serverId);
  const { refresh } = useProvidersSnapshot(serverId);
  const reportActionError = useReportActionError();
  const install = useMutation({
    mutationFn: async (entry: AcpProviderCatalogItem) => {
      const patch = buildAcpProviderConfigPatch(entry, supportsHopliteProvider);
      const managed = shared.installation?.environments.some(
        (environment) => environment.serverId === serverId,
      );
      if (managed) {
        if (!client || !shared.data?.settings || shared.data.conflicts)
          throw new Error(
            "Connect this environment and resolve shared settings migration before installing a runtime.",
          );
        const enrollment = sharedCatalogProviderEnrollment(entry.id, patch.providers![entry.id]!, {
          settings: shared.data.settings,
          serverId,
        });
        if (enrollment.settings)
          await shared.save({
            expectedRevision: shared.data.revision,
            settings: enrollment.settings,
          });
        await client.patchDaemonConfig(enrollment.patch);
      } else {
        await patchConfig(patch);
      }
      await refresh([entry.id]);
    },
    onError: reportActionError,
  });
  const handleInstall = useCallback(
    (entry: AcpProviderCatalogItem) => {
      if (!install.isPending) install.mutate(entry);
    },
    [install],
  );
  const installingProviderId = install.isPending ? install.variables.id : null;
  return (
    <ProviderCatalogList
      serverId={serverId}
      installingProviderId={installingProviderId}
      installError={null}
      onInstall={handleInstall}
    />
  );
}

function useProviderOrder(serverId: string) {
  const { patchConfig } = useDaemonConfig(serverId);
  const reportActionError = useReportActionError();
  const reorder = useMutation({
    mutationFn: async (ordered: ProviderEntry[]) => {
      const providers = Object.fromEntries(
        ordered.map((entry, order) => [entry.provider, { order }]),
      );
      const result = await patchConfig({ providers });
      if (!result) throw new Error("Reconnect to the host and try again.");
    },
    onError: (error) => {
      if (isConnectionError(error)) reportActionError(error);
    },
  });
  return { reorder, status: reorder.isPending ? "Saving provider order..." : null };
}

export function ProvidersSection({ serverId, runtimeOnly = false }: ProvidersSectionProps) {
  const { view } = useProviderUsage(serverId, { enabled: true });
  const usageByProvider = useMemo(
    () =>
      new Map(
        view.kind === "ready"
          ? view.payload.providers.map((usage) => [usage.providerId, usage])
          : [],
      ),
    [view],
  );
  const { t } = useTranslation();
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const supportsCredentialRemoval = useHostFeature(serverId, "providerCredentialRemoval");
  const client = useHostRuntimeClient(serverId);
  const {
    entries,
    isLoading,
    error: snapshotError,
    supportsSnapshot,
    refresh,
  } = useProvidersSnapshot(serverId);
  const panelActive = useRetainedPanelActive();
  const { config: monitorConfig } = useDaemonConfig(serverId);
  const claudeProviders =
    entries
      ?.filter(
        (entry) =>
          entry.enabled &&
          (entry.provider === "claude" ||
            monitorConfig?.providers[entry.provider]?.extends === "claude"),
      )
      .map((entry) => entry.provider) ?? [];
  const claudeEnabled = claudeProviders.length > 0;
  const monitorClaude = panelActive && isConnected && claudeEnabled;
  useFetchQuery({
    dataShape: "value",
    queryKey: ["claude-authentication-monitor", serverId],
    enabled: monitorClaude,
    queryFn: async () => {
      await refresh(claudeProviders);
      return null;
    },
    staleTimeMs: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const { patchConfig } = useDaemonConfig(serverId);
  const { reorder, status: reorderStatus } = useProviderOrder(serverId);
  const primaryConnection = useDaemonPrimaryConnection(serverId);
  const primaryId = primaryConnection.loaded ? (primaryConnection.primary?.provider ?? "") : null;
  const choosePrimary = primaryConnection.choose;
  const handleMakePrimary = useCallback(
    (providerId: string, name: string) =>
      void confirmPrimaryConnection({
        name,
        providerId,
        confirm: confirmDialog,
        choose: choosePrimary,
        toast,
        describeError: toErrorMessage,
      }),
    [choosePrimary, toast],
  );

  const openProviderSettings = useProviderSettingsStore((state) => state.open);
  useState<string | null>(null);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<{ providerId: string; message: string } | null>(
    null,
  );
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(null);
  const removingProviderIdRef = useRef<string | null>(null);
  const [renamingProvider, setRenamingProvider] = useState<ProviderDefinition | null>(null);
  const reportActionError = useReportActionError();

  const providerDefinitions = useMemo(() => buildProviderDefinitions(entries), [entries]);
  const hasServer = serverId.length > 0;
  const closeRename = useCallback(() => setRenamingProvider(null), []);
  const renameProvider = useCallback(
    async (value: string) => {
      if (!renamingProvider) return;
      const result = await patchConfig({
        providers: { [renamingProvider.id]: { label: value.trim() } },
      });
      if (!result) throw new Error("Reconnect to the host and try again.");
    },
    [patchConfig, renamingProvider],
  );

  const handleOpenProviderSettings = useCallback(
    (providerId: string) => {
      openProviderSettings({ serverId, provider: providerId });
    },
    [openProviderSettings, serverId],
  );

  const handleToggleEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      if (!enabled && providerId === primaryId) {
        const label = entries?.find((entry) => entry.provider === providerId)?.label ?? providerId;
        if (!(await confirmDisablePrimary(label, confirmDialog))) return;
      }
      setPendingProviderId(providerId);
      setToggleError((current) => (current?.providerId === providerId ? null : current));
      try {
        await patchConfig({ providers: { [providerId]: { enabled } } });
      } catch (error) {
        // Alert.alert does nothing on web, so the reason stays on the provider's row.
        if (isConnectionError(error)) reportActionError(error);
        else
          setToggleError({
            providerId,
            message: `${t("settings.providers.updateErrorTitle")}: ${toErrorMessage(error)}`,
          });
      } finally {
        setPendingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, reportActionError, t, primaryId, entries],
  );

  const handleRemoveProvider = useCallback(
    async (providerId: string, providerLabel: string) => {
      if (removingProviderIdRef.current) return;
      removingProviderIdRef.current = providerId;
      setRemovingProviderId(providerId);
      try {
        if (!supportsCredentialRemoval)
          throw new Error("Update this host to delete connections and their managed credentials.");
        if (!client) throw new Error("Reconnect to the host and try again.");
        const { plan } = await client.previewProviderRemoval(providerId);
        let message: string;
        if (plan.credentials === "managed")
          message =
            "Delete this connection and its saved credentials? Its local account data will also be permanently removed.";
        else if (plan.credentials === "shared")
          message = `Delete this connection? Credentials shared with ${plan.sharedWith.join(", ")} will remain for those connections.`;
        else
          message =
            "Delete this connection? Credentials stored by an external CLI will remain. Sign out using that CLI to remove them.";
        const confirmed = await confirmDialog({
          title: t("settings.providers.remove.confirmTitle", { name: providerLabel }),
          message,
          confirmLabel: t("settings.providers.remove.confirm"),
          destructive: true,
        });
        if (!confirmed) return;
        await client.removeProvider(providerId, plan.revision);
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        if (removingProviderIdRef.current === providerId) removingProviderIdRef.current = null;
        setRemovingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [t, supportsCredentialRemoval, client, toast],
  );

  // The skeleton shows only while a snapshot is actually on its way. A host that is offline,
  // failed, or never reports a snapshot gets a sentence instead of a skeleton that never resolves.
  const listState = providerListState({
    hasServer,
    isConnected,
    supportsSnapshot,
    isLoading,
    error: snapshotError,
    entryCount: entries ? providerDefinitions.length : null,
  });
  let listMessage: string | null = null;
  if (listState === "unavailable") listMessage = t("settings.providers.unavailable");
  else if (listState !== "ready" && listState !== "loading") listMessage = LIST_MESSAGES[listState];
  return (
    <>
      {/* The pane header already says Providers, so this list carries no second heading. */}
      {!runtimeOnly ? (
        <View testID="host-page-providers-card" style={styles.sectionSpacing}>
          <ProviderListStatus message={listMessage} busy={reorderStatus} />
          {listState === "loading" ? <ProviderRowsSkeleton /> : null}
          {entries && providerDefinitions.length > 0 ? (
            <ProviderList
              reorder={reorder}
              serverId={serverId}
              entries={entries ?? []}
              usageByProvider={usageByProvider}
              pendingProviderId={pendingProviderId}
              removingProviderId={removingProviderId}
              supportsProviderRemoval={supportsProviderRemoval}
              onPress={handleOpenProviderSettings}
              onToggleEnabled={handleToggleEnabled}
              onRemove={handleRemoveProvider}
              onRename={setRenamingProvider}
              primaryId={primaryId}
              onMakePrimary={handleMakePrimary}
              toggleError={toggleError}
            />
          ) : null}
        </View>
      ) : null}

      {hasServer ? (
        <SettingsSection
          title={t("settings.providers.addProvider")}
          testID="host-page-add-provider-card"
          style={styles.addProviderSection}
        >
          <ProviderCatalogInstallation serverId={serverId} />
        </SettingsSection>
      ) : null}
      {renamingProvider ? (
        <AdaptiveRenameModal
          key={renamingProvider.id}
          visible
          title="Rename provider"
          initialValue={renamingProvider.label}
          onClose={closeRename}
          onSubmit={renameProvider}
          testID="provider-rename-dialog"
        />
      ) : null}
    </>
  );
}

type ProviderListState = "unavailable" | "unsupported" | "error" | "loading" | "empty" | "ready";

// "Unavailable" uses the translated string the section already had.
const LIST_MESSAGES: Record<
  Exclude<ProviderListState, "ready" | "loading" | "unavailable">,
  string
> = {
  unsupported: "This host does not report its providers. Update it to manage them here.",
  error: "Providers could not be loaded. Reconnect to the host and try again.",
  empty: "No providers on this host yet. Add one below.",
};

/** Exported for tests: which of the list's states a host is in. */
export function providerListState(input: {
  hasServer: boolean;
  isConnected: boolean;
  supportsSnapshot: boolean;
  isLoading: boolean;
  error: string | null;
  /** Null until a snapshot has arrived. */
  entryCount: number | null;
}): ProviderListState {
  if (input.entryCount !== null) return input.entryCount > 0 ? "ready" : "empty";
  if (!input.hasServer || !input.isConnected) return "unavailable";
  if (!input.supportsSnapshot) return "unsupported";
  if (input.error) return "error";
  return input.isLoading ? "loading" : "empty";
}

/**
 * One line for the list's state and for a reorder in progress. It is always mounted, so screen
 * readers announce its first message, and takes no space while there is nothing to say.
 */
function ProviderListStatus({ message, busy }: { message: string | null; busy: string | null }) {
  const text = message ?? busy ?? "";
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={text ? settingsStyles.rowHint : styles.statusIdle}
      testID={text ? "providers-connection-status" : undefined}
    >
      {text}
    </Text>
  );
}

interface ProviderListProps extends Pick<
  ProviderRowProps,
  "serverId" | "onPress" | "onToggleEnabled" | "onRemove" | "onRename"
> {
  reorder: ReturnType<typeof useMutation<void, Error, ProviderEntry[]>>;
  entries: ProviderEntry[];
  usageByProvider: Map<string, ProviderUsage>;
  pendingProviderId: string | null;
  removingProviderId: string | null;
  supportsProviderRemoval: boolean;
  /** The primary provider id, "" when none is chosen, or null where the setting is unavailable. */
  primaryId?: string | null;
  onMakePrimary?: (providerId: string, providerLabel: string) => void;
  toggleError?: { providerId: string; message: string } | null;
}

function ProviderList({
  reorder,
  serverId,
  entries,
  usageByProvider,
  pendingProviderId,
  removingProviderId,
  supportsProviderRemoval,
  onPress,
  onToggleEnabled,
  onRemove,
  onRename,
  primaryId = null,
  toggleError = null,
  onMakePrimary,
}: ProviderListProps) {
  const supportsProviderOrdering = useHostFeature(serverId, "providerOrdering");
  const canReorder = supportsProviderOrdering;
  const { mutateAsync: saveOrder } = reorder;
  const reorderProviders = useCallback(
    (ordered: ProviderEntry[]) => {
      return saveOrder(ordered);
    },
    [saveOrder],
  );

  // The drag alternative for screen readers: swap with the neighbouring provider.
  const move = useCallback(
    (providerId: string, offset: -1 | 1) => {
      const from = entries.findIndex((entry) => entry.provider === providerId);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= entries.length || reorder.isPending) return;
      const ordered = [...entries];
      [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
      void saveOrder(ordered).catch(() => undefined);
    },
    [entries, saveOrder, reorder.isPending],
  );
  const renderProvider = useCallback(
    ({ item: entry, index, drag, dragHandleProps }: DraggableRenderItemInfo<ProviderEntry>) => {
      const def = buildProviderDefinitions([entry])[0];
      return (
        <ProviderRow
          key={def.id}
          serverId={serverId}
          def={def}
          usage={usageByProvider.get(def.id)}
          entry={entry}
          enabled={entry.enabled ?? true}
          isToggling={pendingProviderId === def.id}
          isRemoving={removingProviderId === def.id}
          canRemove={supportsProviderRemoval && entry.source === "custom"}
          isFirst={index === 0}
          isLast={index === entries.length - 1}
          drag={drag}
          dragHandleProps={dragHandleProps}
          canReorder={canReorder}
          reorderPending={reorder.isPending}
          onPress={onPress}
          onToggleEnabled={onToggleEnabled}
          onRemove={onRemove}
          onRename={onRename}
          primary={primaryId === null ? null : primaryId === def.id}
          onMakePrimary={onMakePrimary}
          actionError={toggleError?.providerId === def.id ? toggleError.message : null}
          onMove={move}
        />
      );
    },
    [
      serverId,
      usageByProvider,
      pendingProviderId,
      removingProviderId,
      supportsProviderRemoval,
      canReorder,
      reorder.isPending,
      onPress,
      onToggleEnabled,
      onRemove,
      onRename,
      primaryId,
      onMakePrimary,
      move,
      toggleError,
      entries.length,
    ],
  );

  const isReorderRejected = reorder.isError && !isConnectionError(reorder.error);
  return (
    <View style={settingsStyles.card}>
      {canReorder ? (
        <DraggableList
          data={entries}
          keyExtractor={providerKey}
          renderItem={renderProvider}
          onDragEnd={reorderProviders}
          useDragHandle
          scrollEnabled={false}
          testID="provider-order-list"
        />
      ) : (
        entries.map((item, index) => renderProvider({ item, index, drag: noop, isActive: false }))
      )}
      {isReorderRejected ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {toErrorMessage(reorder.error)}
        </Text>
      ) : null}
    </View>
  );
}

function providerKey(entry: ProviderEntry) {
  return entry.provider;
}
function noop() {}

const styles = StyleSheet.create((theme) => ({
  draggableRow: { flexDirection: "row", alignItems: "center" },
  rowStack: { flex: 1, minWidth: 0 },
  stackedRow: { flex: 0 },
  // 44px on touch layouts, 32px where a pointer drives it.
  dragHandle: {
    width: CONTROL_HEIGHTS.md,
    minHeight: CONTROL_HEIGHTS.md,
    alignItems: "center",
    justifyContent: "center",
  },
  statusIdle: { height: 0, overflow: "hidden" },
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  addProviderSection: {
    marginTop: theme.spacing[4],
  },
  row: {
    flex: 1,
    gap: theme.spacing[3],
  },
  // Only the details button lights the row, not the controls beside it, so the row matches a
  // hovered descendant with :has() rather than its own :hover.
  rowHovered: CAN_HOVER
    ? {
        _web: {
          "_has(.vorteo-hover-provider-details:hover)": {
            backgroundColor: theme.colors.surface2,
          },
        },
      }
    : {},
  compactRow: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  skeletonIcon: {
    width: 20,
    height: 20,
    marginLeft: theme.spacing[6],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  skeletonTitle: {
    width: 160,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonSwitch: {
    width: 36,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    ...hoverStyle({ color: theme.colors.foreground }, { color: theme.colors.foregroundMuted }),
  },
  rowContentGroup: hoverGroup("provider-details"),
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusRow: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  separator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  trailingControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  vortonTrailingControls: {
    gap: theme.spacing[2],
  },
}));
