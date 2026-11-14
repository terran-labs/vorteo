import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { ChevronRight, GripVertical } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import {
  awaitingFirstConnection,
  connectionsNeedingSignIn,
  groupInstallationProviders,
  providerInstallHint,
  providerInstallCommand,
  type ConnectionSignIn,
  type ProviderFamily,
} from "./shared-providers-model";
import { useProviderDetection, useSignInSources } from "./use-provider-detection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type AccessibilityActionEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CAN_HOVER, hoverGroup, hoverStyle } from "@/styles/hover";
import { useMutation } from "@tanstack/react-query";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type {
  InstallationSettingsSnapshot,
  InstallationSettings,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { CardHeaderStatus } from "@/components/ui/card-header-status";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useReportActionError } from "@/hooks/use-action-error";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  confirmDisablePrimary,
  isPrimaryConnection,
  usePrimaryConnection,
} from "@/execution-installation/primary-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isWeb } from "@/constants/platform";
import { useInstallationSettings } from "@/execution-installation/settings";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { ProvidersSection } from "./providers-section";
import { environmentLabel } from "./provider-connection-status";
import { ProviderDetail } from "./provider-detail-page";
import { providerRowAnchorId, useSettingsFocus } from "./settings-focus";

const ThemedGrip = withUnistyles(GripVertical);
const ThemedChevron = withUnistyles(ChevronRight);
const gripColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** "2 connections", or what is wrong when nothing is enabled. */
function familySummary(family: ProviderFamily, awaitingConnection: boolean): string {
  if (family.installed === false) return "Not installed";
  if (family.installed === null) return "Checking";
  if (awaitingConnection) return "Not connected";
  const count = family.accounts.length;
  const connections = count === 1 ? "1 connection" : `${count} connections`;
  return family.enabled ? connections : `Off · ${connections}`;
}

/**
 * A provider's row. Pressing its name expands the provider's connections,
 * profiles and model defaults underneath as divided rows in the same card,
 * and the chevron turns down. A provider whose only connection is signed out
 * also shows Connect beside its switch, as a shortcut; it never replaces them.
 */
function ProviderFamilyCard({
  family,
  snapshot,
  busy,
  save,
  expanded,
  onToggleExpanded,
  drag,
  dragHandleProps,
  showDrag = false,
  primary = false,
  firstConnection = null,
  onMove,
  canMoveUp = false,
  canMoveDown = false,
}: {
  /** The family holds the installation's primary connection. */
  primary?: boolean;
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  expanded: boolean;
  onToggleExpanded(providerType: string): void;
  drag(): void;
  dragHandleProps?: DraggableListDragHandleProps;
  showDrag?: boolean;
  /** Set while the provider's only connection is signed out. */
  firstConnection?: ConnectionSignIn | null;
  /** Moves the provider one place up (-1) or down (1) without dragging. */
  onMove?(providerType: string, offset: -1 | 1): void;
  /** Whether the provider can move up or down in its list; drives the visible move buttons. */
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const toggle = useCallback(
    async (enabled: boolean) => {
      if (!enabled && primary && !(await confirmDisablePrimary(family.name, confirmDialog))) return;
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings?.providerDefinitions?.map((entry) =>
            entry.providerType === family.id && !entry.removed
              ? { ...entry, policy: { ...entry.policy, enabled } }
              : entry,
          ),
        },
      });
    },
    [save, snapshot, family.id, family.name, primary],
  );
  const toggleExpanded = useCallback(
    () => onToggleExpanded(family.id),
    [onToggleExpanded, family.id],
  );
  const open = expanded;
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`.
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": open } as const) : null),
    [open],
  );
  const chevronStyle = useMemo(() => [open && styles.chevronExpanded], [open]);
  const titleStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.title,
      styles.titleGroup,
      pressed && styles.titlePressed,
    ],
    [],
  );
  const cardStyle = useMemo(
    () => [family.installed !== false && settingsStyles.card, styles.item],
    [family.installed],
  );
  const summary = familySummary(family, Boolean(firstConnection));
  const nameBlock = (
    <FamilyName id={family.id} name={family.name} primary={primary} summary={summary} />
  );
  return (
    <View
      style={cardStyle}
      nativeID={providerRowAnchorId(family.id)}
      testID={`provider-family-${family.id}`}
    >
      <View style={[styles.heading, styles.familyHeading, showDrag && styles.headingWithDrag]}>
        {showDrag ? (
          <FamilyDragHandle
            id={family.id}
            name={family.name}
            busy={busy}
            drag={drag}
            dragHandleProps={dragHandleProps}
            onMove={onMove}
          />
        ) : null}
        <Pressable
          {...webExpandedProps}
          onPress={toggleExpanded}
          style={titleStyle}
          accessibilityRole="button"
          accessibilityLabel={`${family.name}${primary ? ", primary" : ""} details, ${summary}`}
          accessibilityState={accessibilityState}
          testID={`provider-family-open-${family.id}`}
        >
          <View style={chevronStyle}>
            <ThemedChevron size={16} uniProps={gripColor} />
          </View>
          {nameBlock}
        </Pressable>
        <View style={styles.trailing}>
          {firstConnection ? (
            <ProviderReconnectControl
              serverId={firstConnection.serverId}
              providerId={firstConnection.providerId}
              name={family.name}
              usage={firstConnection.usage}
            />
          ) : null}
          {/* A switch for a CLI that is installed nowhere would change nothing. */}
          {family.installed ? (
            <Switch
              value={family.enabled}
              onValueChange={toggle}
              disabled={busy}
              accessibilityLabel={`Enable ${family.name} everywhere`}
            />
          ) : null}
          {family.installed === false ? (
            <Button
              {...webExpandedProps}
              variant="outline"
              size="sm"
              onPress={toggleExpanded}
              accessibilityState={accessibilityState}
              accessibilityLabel={`Show ${family.name} install command`}
            >
              Show install command
            </Button>
          ) : null}
        </View>
      </View>
      {open ? (
        <View testID={`provider-family-detail-${family.id}`}>
          {family.installed === false ? (
            <InstallCommand providerType={family.id} name={family.name} />
          ) : (
            <>
              {canMoveUp || canMoveDown ? (
                <FamilyOrder
                  id={family.id}
                  name={family.name}
                  busy={busy}
                  canMoveUp={canMoveUp}
                  canMoveDown={canMoveDown}
                  onMove={onMove}
                />
              ) : null}
              <ProviderDetail providerType={family.id} />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * On web the dnd-kit wrapper is the one keyboard stop and button; screen readers on native move
 * the provider with the Move up and Move down actions instead of dragging.
 */
function FamilyDragHandle({
  id,
  name,
  busy,
  drag,
  dragHandleProps,
  onMove,
}: {
  id: string;
  name: string;
  busy: boolean;
  drag(): void;
  dragHandleProps?: DraggableListDragHandleProps;
  onMove?(providerType: string, offset: -1 | 1): void;
}) {
  const handleReorderAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "moveUp") onMove?.(id, -1);
      else if (event.nativeEvent.actionName === "moveDown") onMove?.(id, 1);
    },
    [onMove, id],
  );
  return (
    <View
      {...dragHandleProps?.attributes}
      {...(!busy ? dragHandleProps?.listeners : undefined)}
      ref={dragHandleProps?.setActivatorNodeRef}
      accessibilityLabel={`Reorder ${name}`}
      testID={`provider-family-drag-${id}`}
    >
      <Pressable
        onLongPress={drag}
        disabled={busy}
        focusable={!isWeb}
        // On web the wrapper is already the button; a second one inside it is invalid HTML.
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={`Reorder ${name}`}
        accessibilityHint="Long press, then drag to change the order"
        accessibilityActions={REORDER_ACTIONS}
        onAccessibilityAction={handleReorderAction}
        style={styles.dragHandle}
      >
        <ThemedGrip size={18} uniProps={gripColor} />
      </Pressable>
    </View>
  );
}

/** A provider that is installed nowhere: its install command, with a confirmed copy. */
function InstallCommand({ providerType, name }: { providerType: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const command = providerInstallCommand(providerType) ?? providerInstallHint(providerType);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(command).then(() => setCopied(true));
  }, [command]);
  return (
    <View style={styles.command}>
      <Text selectable style={styles.commandText}>
        {command}
      </Text>
      <Button
        variant="outline"
        size="sm"
        onPress={copy}
        accessibilityLabel={`Copy ${name} install command`}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      <Text accessibilityLiveRegion="polite" style={styles.copied}>
        {copied ? "Install command copied" : ""}
      </Text>
    </View>
  );
}

/** Visible move buttons, so ordering never depends on dragging. */
function FamilyOrder({
  id,
  name,
  busy,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  id: string;
  name: string;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove?(providerType: string, offset: -1 | 1): void;
}) {
  const up = useCallback(() => onMove?.(id, -1), [onMove, id]);
  const down = useCallback(() => onMove?.(id, 1), [onMove, id]);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <Text style={[settingsStyles.rowHint, styles.orderLabel]}>Order in the picker</Text>
      <View style={styles.trailing}>
        <Button
          variant="outline"
          onPress={up}
          disabled={busy || !canMoveUp}
          accessibilityLabel={`Move ${name} up`}
          testID={`provider-family-move-up-${id}`}
        >
          Move up
        </Button>
        <Button
          variant="outline"
          onPress={down}
          disabled={busy || !canMoveDown}
          accessibilityLabel={`Move ${name} down`}
          testID={`provider-family-move-down-${id}`}
        >
          Move down
        </Button>
      </View>
    </View>
  );
}

function FamilyName({
  id,
  name,
  primary,
  summary,
}: {
  id: string;
  name: string;
  primary: boolean;
  summary: string;
}) {
  return (
    <View style={styles.content}>
      <View style={styles.name}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {name}
        </Text>
        {primary ? (
          <View testID={`provider-family-primary-${id}`}>
            <StatusBadge label="Primary" size="xs" variant="success" />
          </View>
        ) : null}
      </View>
      <Text style={styles.summary} numberOfLines={1}>
        {summary}
      </Text>
    </View>
  );
}

function RestoreProviderRow({
  family,
  restore,
  busy,
}: {
  family: ProviderFamily;
  restore(family: ProviderFamily): void;
  busy: boolean;
}) {
  const onRestore = useCallback(() => restore(family), [restore, family]);
  return (
    <View style={styles.heading}>
      <Text style={[settingsStyles.rowTitle, styles.content]}>{family.name}</Text>
      <Button variant="outline" onPress={onRestore} disabled={busy}>
        Restore provider
      </Button>
    </View>
  );
}

const REORDER_ACTIONS = [
  { name: "moveUp", label: "Move up" },
  { name: "moveDown", label: "Move down" },
];

function familyKey(family: ProviderFamily) {
  return family.id;
}

type ProviderCatalogSnapshot = InstallationSettingsSnapshot & {
  settings: InstallationSettings & {
    providerDefinitions: InstallationProvider[];
  };
};

export function SharedProvidersPage() {
  const { data, installation, save } = useInstallationSettings();
  const environments = useMemo(() => installation?.environments ?? [], [installation]);
  const snapshot = useMemo(
    () =>
      data?.settings?.providerDefinitions
        ? {
            ...data,
            settings: {
              ...data.settings,
              providerDefinitions: data.settings.providerDefinitions,
            },
          }
        : null,
    [data],
  );
  if (!snapshot)
    return (
      <View
        style={[settingsStyles.card, styles.skeleton]}
        testID="shared-providers-loading"
        dataSet={loadingPane}
        accessibilityLabel={
          data
            ? "Shared provider list unavailable. Complete shared provider migration to manage the catalog."
            : "Loading providers"
        }
      >
        {data ? (
          <Text style={settingsStyles.rowHint}>
            The shared provider list is not available yet. Complete shared provider migration to
            manage the catalog.
          </Text>
        ) : null}
      </View>
    );
  return <ProviderCatalog data={snapshot} environments={environments} save={save} />;
}

function ProviderCatalog({
  data,
  environments,
  save,
}: {
  data: ProviderCatalogSnapshot;
  environments: InstallationEnvironment[];
  save: ReturnType<typeof useInstallationSettings>["save"];
}) {
  const [adding, setAdding] = useState(false);
  const [useDev, setUseDev] = useState(false);
  const reportActionError = useReportActionError();
  const change = useMutation({ mutationFn: save, onError: reportActionError });
  const { primary } = usePrimaryConnection();
  const [showAvailable, setShowAvailable] = useState(false);
  const toggleAvailable = useCallback(() => setShowAvailable((value) => !value), []);
  // One provider open at a time; a provider address opens with it expanded.
  const focus = useSettingsFocus();
  const focusedType = focus?.kind === "provider" ? focus.providerType : null;
  const [expanded, setExpanded] = useState<string | null>(focusedType);
  useEffect(() => {
    if (focusedType) setExpanded(focusedType);
  }, [focusedType]);
  const toggleExpanded = useCallback(
    (providerType: string) =>
      setExpanded((current) => (current === providerType ? null : providerType)),
    [],
  );
  const definitions = useMemo(
    () =>
      [
        ...((change.isPending ? change.variables?.settings.providerDefinitions : undefined) ??
          data.settings.providerDefinitions ??
          []),
      ].sort(
        (left, right) =>
          (left.policy.order ?? Number.MAX_SAFE_INTEGER) -
          (right.policy.order ?? Number.MAX_SAFE_INTEGER),
      ),
    [data.settings.providerDefinitions, change.isPending, change.variables],
  );
  // Installs and sign-ins run on Host; the Dev container is the rare exception.
  const host = environments.find((environment) => environment.kind === "host");
  const dev = environments.find((environment) => environment.kind === "container");
  const target = (useDev ? dev : host) ?? host ?? dev;
  const other = target === host ? dev : host;
  const switchTarget = useCallback(() => setUseDev((value) => !value), []);
  const detection = useProviderDetection(environments);
  const removedFamilies = useMemo(
    () => groupInstallationProviders(definitions, "removed"),
    [definitions],
  );
  const restore = useCallback(
    (family: ProviderFamily) => {
      change.mutate({
        expectedRevision: data.revision,
        settings: {
          providerDefinitions: data.settings.providerDefinitions.map((entry) =>
            entry.providerType === family.id
              ? {
                  ...entry,
                  removed: false,
                  policy: { ...entry.policy, enabled: false },
                }
              : entry,
          ),
        },
      });
    },
    [data, change],
  );
  const families = useMemo(
    () => groupInstallationProviders(definitions, "active", detection),
    [definitions, detection],
  );
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const addHeader = useMemo(() => ({ title: "Add provider" }), []);
  const reorder = useCallback(
    (ordered: ProviderFamily[]) => {
      const ids = new Set(ordered.map((family) => family.id));
      let next = 0;
      const merged = families.map((family) => (ids.has(family.id) ? ordered[next++] : family));
      const rank = new Map(merged.map((family, index) => [family.id, index]));
      return change.mutateAsync({
        expectedRevision: data.revision,
        settings: {
          providerDefinitions: data.settings.providerDefinitions.map((entry) => ({
            ...entry,
            policy: {
              ...entry.policy,
              order: rank.get(entry.providerType) ?? merged.length,
            },
          })),
        },
      });
    },
    [data, change, families],
  );
  const signInSources = useSignInSources(environments);
  // Where a provider sits in its on or off list, for the drag handle and the move buttons.
  const movePosition = useCallback(
    (item: ProviderFamily) => {
      const list = families.filter(
        (family) => family.installed === true && family.enabled === item.enabled,
      );
      const index = list.indexOf(item);
      return {
        showDrag: item.installed === true && list.length > 1,
        canMoveUp: index > 0,
        canMoveDown: index >= 0 && index < list.length - 1,
      };
    },
    [families],
  );
  // The drag alternative: swap with the neighbour in the same on or off list.
  const move = useCallback(
    (providerType: string, offset: -1 | 1) => {
      const item = families.find((family) => family.id === providerType);
      if (!item) return;
      const list = families.filter(
        (family) => family.installed === true && family.enabled === item.enabled,
      );
      const from = list.indexOf(item);
      const to = from + offset;
      if (to < 0 || to >= list.length) return;
      const ordered = [...list];
      [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
      void reorder(ordered).catch(() => undefined);
    },
    [families, reorder],
  );
  const renderFamily = useCallback(
    ({ item, drag, dragHandleProps }: DraggableRenderItemInfo<ProviderFamily>) => (
      <ProviderFamilyCard
        family={item}
        snapshot={data}
        busy={change.isPending}
        save={change.mutate}
        expanded={item.id === expanded}
        onToggleExpanded={toggleExpanded}
        primary={item.accounts.some((account) => isPrimaryConnection(primary, account.definitions))}
        firstConnection={awaitingFirstConnection(item, signInSources)}
        onMove={move}
        {...movePosition(item)}
        drag={drag}
        dragHandleProps={dragHandleProps}
      />
    ),
    [data, change, expanded, toggleExpanded, primary, signInSources, move, movePosition],
  );
  const availableFamilies = useMemo(
    () => families.filter((family) => family.installed === false),
    [families],
  );
  const openedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedType) {
      openedFocus.current = null;
    } else if (
      openedFocus.current !== focusedType &&
      availableFamilies.some((family) => family.id === focusedType)
    ) {
      openedFocus.current = focusedType;
      setShowAvailable(true);
    }
  }, [focusedType, availableFamilies]);
  const availableState = useMemo(() => ({ expanded: showAvailable }), [showAvailable]);
  const availableWebProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": showAvailable } as const) : null),
    [showAvailable],
  );
  const noDrag = useCallback(() => undefined, []);
  // Providers with nothing connected yet show their own Connect button, so the walkthrough
  // only covers connections that were working and have since expired or signed out.
  const expired = useMemo(
    () =>
      connectionsNeedingSignIn(
        families.filter((family) => !awaitingFirstConnection(family, signInSources)),
        signInSources,
      ),
    [families, signInSources],
  );
  return (
    <View testID="shared-providers">
      {/* The pane header already names this page, so the list carries no second Providers
          heading. Its explanation, save status and page actions share one toolbar row. */}
      <View style={styles.toolbar}>
        <SettingsInfoTip
          title="Providers"
          info="Providers and their connections work in every environment. Expand a provider to manage its connections, profiles and model defaults. Drag installed providers, or use Move up and Move down inside a provider, to set their order in the picker."
          testID="shared-providers-info"
        />
        <CardHeaderStatus text={change.isPending ? "Saving provider settings..." : null} />
        <ReconnectAllControl connections={expired} />
        <Button variant="outline" onPress={openAdd} testID="shared-providers-add">
          Add provider
        </Button>
      </View>
      {[true, false].map((enabled) => (
        <DraggableList
          key={String(enabled)}
          data={families.filter(
            (family) => family.installed !== false && family.enabled === enabled,
          )}
          keyExtractor={familyKey}
          renderItem={renderFamily}
          onDragEnd={reorder}
          scrollEnabled={false}
          useDragHandle
          testID={enabled ? "shared-provider-order-list" : "shared-provider-off-list"}
        />
      ))}
      {availableFamilies.length > 0 ? (
        <View>
          <Pressable
            {...availableWebProps}
            onPress={toggleAvailable}
            accessibilityRole="button"
            accessibilityState={availableState}
            accessibilityLabel={`Available to install, ${availableFamilies.length}`}
            style={styles.availableToggle}
            testID="shared-providers-available-toggle"
          >
            <ThemedChevron
              size={16}
              uniProps={gripColor}
              style={showAvailable ? styles.chevronExpanded : undefined}
            />
            <Text style={settingsStyles.rowTitle}>
              {`Available to install (${availableFamilies.length})`}
            </Text>
          </Pressable>
          {showAvailable &&
            availableFamilies.map((family) => (
              <ProviderFamilyCard
                key={family.id}
                family={family}
                snapshot={data}
                busy={change.isPending}
                save={change.mutate}
                expanded={expanded === family.id}
                onToggleExpanded={toggleExpanded}
                drag={noDrag}
              />
            ))}
        </View>
      ) : null}
      <AdaptiveModalSheet
        testID="provider-add-sheet"
        visible={adding}
        onClose={closeAdd}
        header={addHeader}
      >
        <Text style={settingsStyles.rowHint}>
          Install or sign in once. Vorteo shares providers with every environment.
        </Text>
        {removedFamilies.map((family) => (
          <RestoreProviderRow
            key={family.id}
            family={family}
            restore={restore}
            busy={change.isPending}
          />
        ))}
        {target ? <ProvidersSection serverId={target.serverId} runtimeOnly /> : null}
        {other ? (
          <Button variant="outline" size="sm" onPress={switchTarget}>
            {`Install in ${environmentLabel(other)} instead`}
          </Button>
        ) : null}
      </AdaptiveModalSheet>
    </View>
  );
}

type PendingSignIn = ConnectionSignIn & { name: string };

/**
 * Walks the owner through every expired or signed-out connection, one at a time, through each
 * connection's own reconnect dialog. The dialog opens for each connection in turn. Signing in or
 * Skip moves on, cancelling the dialog or Stop ends the walkthrough, and a failure offers Try
 * again or Skip. Connections that sign in elsewhere before their turn are passed over.
 */
function ReconnectAllControl({ connections }: { connections: readonly PendingSignIn[] }) {
  // The queue is fixed when the walkthrough starts, so progress reads "2 of 4" throughout and
  // the current connection stays put while its dialog reports that it signed in.
  const [queue, setQueue] = useState<PendingSignIn[] | null>(null);
  const [position, setPosition] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useMemo(
    () => new Set(connections.map((connection) => connection.accountId)),
    [connections],
  );
  const advance = useCallback(
    (from: number) => {
      if (!queue) return;
      const next = queue.findIndex((item, index) => index > from && pending.has(item.accountId));
      setFailed(false);
      if (next < 0) {
        setQueue(null);
        setDialogOpen(false);
        return;
      }
      setPosition(next);
      setDialogOpen(true);
    },
    [queue, pending],
  );
  const start = useCallback(() => {
    setQueue([...connections]);
    setPosition(0);
    setFailed(false);
    setDialogOpen(true);
  }, [connections]);
  const stop = useCallback(() => {
    setQueue(null);
    setDialogOpen(false);
    setFailed(false);
  }, []);
  const skip = useCallback(() => advance(position), [advance, position]);
  // A new attempt clears the last failure, so "did not connect" never shows while it runs.
  const changeDialogOpen = useCallback((next: boolean) => {
    setDialogOpen(next);
    if (next) setFailed(false);
  }, []);
  const retry = useCallback(() => {
    setFailed(false);
    setDialogOpen(true);
  }, []);
  const finished = useCallback(
    (result: "connected" | "cancelled" | "failed") => {
      setDialogOpen(false);
      if (result === "connected") advance(position);
      else if (result === "cancelled") stop();
      else setFailed(true);
    },
    [advance, position, stop],
  );
  if (!queue) {
    if (connections.length === 0) return null;
    return (
      <Button variant="outline" onPress={start} testID="shared-providers-reconnect-all">
        {connections.length === 1
          ? "Reconnect 1 expired"
          : `Reconnect ${connections.length} expired`}
      </Button>
    );
  }
  const connection = queue[position];
  if (!connection) return null;
  const progress = `${position + 1} of ${queue.length}`;
  return (
    <View
      style={styles.walkthrough}
      accessibilityLabel={`Reconnecting expired connections, ${progress}`}
      testID="shared-providers-reconnect-walkthrough"
    >
      <Text
        style={failed ? styles.walkthroughError : styles.summary}
        numberOfLines={2}
        accessibilityLiveRegion="polite"
      >
        {failed
          ? `${progress}: ${connection.name} did not connect`
          : `${progress}: ${connection.name}`}
      </Text>
      {/* The control's own button stays visible, so the owner can reopen a closed dialog. */}
      <ProviderReconnectControl
        key={connection.accountId}
        serverId={connection.serverId}
        providerId={connection.providerId}
        name={connection.name}
        usage={connection.usage}
        open={dialogOpen}
        onOpenChange={changeDialogOpen}
        onFinished={finished}
      />
      {failed ? (
        <Button
          variant="default"
          onPress={retry}
          accessibilityLabel={`Try connecting ${connection.name} again`}
          testID="shared-providers-reconnect-retry"
        >
          Try again
        </Button>
      ) : null}
      <Button
        variant="outline"
        onPress={skip}
        accessibilityLabel={`Skip ${connection.name}`}
        testID="shared-providers-reconnect-skip"
      >
        Skip
      </Button>
      <Button
        variant="outline"
        onPress={stop}
        accessibilityLabel="Stop reconnecting"
        testID="shared-providers-reconnect-stop"
      >
        Stop
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  item: { marginBottom: theme.spacing[2] },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  // The walkthrough takes its own line under the toolbar, so its controls never squeeze.
  walkthroughError: {
    flexShrink: 1,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  walkthrough: {
    flexBasis: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // The chevron starts on the card's content inset, like the rows below it.
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  // The drag handle's own width supplies the inset instead.
  headingWithDrag: { paddingLeft: 0 },
  // Hovering the name lights the whole header across the card, not an inset box. The switch
  // beside the name is a sibling, so the header matches a hovered descendant with :has().
  familyHeading: CAN_HOVER
    ? {
        _web: {
          "_has(.vorteo-hover-provider-family:hover)": {
            backgroundColor: theme.colors.interactionHighlight,
          },
        },
      }
    : {},
  title: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // A full touch target in the compact layout; the pointer layout keeps the row tight.
    minHeight: CONTROL_HEIGHTS.md,
  },
  titleGroup: hoverGroup("provider-family"),
  titlePressed: { opacity: 0.7 },
  content: { flex: 1, minWidth: 0 },
  name: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  summary: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // 44px on touch layouts, 32px where a pointer drives it.
  dragHandle: {
    width: CONTROL_HEIGHTS.md,
    minHeight: CONTROL_HEIGHTS.md,
    alignItems: "center",
    justifyContent: "center",
  },
  orderLabel: { flex: 1, marginTop: 0 },
  copied: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  trailing: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  availableToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    ...hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
  },
  skeleton: { height: 96, padding: theme.spacing[3], justifyContent: "center" },
  command: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  commandText: { flex: 1, minWidth: 200, fontFamily: "monospace", color: theme.colors.foreground },
}));

const loadingPane = { settingsLoading: "true" };
