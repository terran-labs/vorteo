import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { ChevronRight, GripVertical } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import {
  groupInstallationProviders,
  providerInstallHint,
  providerInstallCommand,
  type ProviderFamily,
} from "./shared-providers-model";
import { useProviderDetection } from "./use-provider-detection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { hoverStyle } from "@/styles/hover";
import { useMutation } from "@tanstack/react-query";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type {
  InstallationSettingsSnapshot,
  InstallationSettings,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsExpansion } from "@/components/settings/settings-expansion";
import { useReportActionError } from "@/hooks/use-action-error";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
function familySummary(family: ProviderFamily): string {
  if (family.installed === false) return "Not installed";
  if (family.installed === null) return "Checking";
  const count = family.accounts.length;
  const connections = count === 1 ? "1 connection" : `${count} connections`;
  return family.enabled ? connections : `Off · ${connections}`;
}

/**
 * A provider's row. Pressing its name expands the provider's connections,
 * profiles and model defaults underneath, and the chevron turns down.
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
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  expanded: boolean;
  onToggleExpanded(providerType: string): void;
  drag(): void;
  dragHandleProps?: DraggableListDragHandleProps;
  showDrag?: boolean;
}) {
  const toggle = useCallback(
    (enabled: boolean) =>
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings?.providerDefinitions?.map((entry) =>
            entry.providerType === family.id && !entry.removed
              ? { ...entry, policy: { ...entry.policy, enabled } }
              : entry,
          ),
        },
      }),
    [save, snapshot, family.id],
  );
  const toggleExpanded = useCallback(
    () => onToggleExpanded(family.id),
    [onToggleExpanded, family.id],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`.
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const chevronStyle = useMemo(() => [expanded && styles.chevronExpanded], [expanded]);
  const titleStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.title,
      styles.titleHover,
      pressed && styles.titleHovered,
    ],
    [],
  );
  const cardStyle = useMemo(
    () => [family.installed !== false && settingsStyles.card, styles.item],
    [family.installed],
  );
  const copyCommand = useCallback(
    () =>
      void Clipboard.setStringAsync(
        providerInstallCommand(family.id) ?? providerInstallHint(family.id),
      ),
    [family.id],
  );
  return (
    <View
      style={cardStyle}
      nativeID={providerRowAnchorId(family.id)}
      testID={`provider-family-${family.id}`}
    >
      <View style={styles.heading}>
        {showDrag ? (
          <View
            {...dragHandleProps?.attributes}
            {...(!busy ? dragHandleProps?.listeners : undefined)}
            ref={dragHandleProps?.setActivatorNodeRef}
            accessibilityLabel={`Reorder ${family.name}`}
            testID={`provider-family-drag-${family.id}`}
          >
            <Pressable onLongPress={drag} disabled={busy} style={styles.dragHandle}>
              <ThemedGrip size={18} uniProps={gripColor} />
            </Pressable>
          </View>
        ) : null}
        {!showDrag && family.installed !== false ? <View style={styles.dragHandle} /> : null}
        <Pressable
          {...webExpandedProps}
          onPress={toggleExpanded}
          style={titleStyle}
          accessibilityRole="button"
          accessibilityLabel={`${family.name} details`}
          accessibilityState={accessibilityState}
          testID={`provider-family-open-${family.id}`}
        >
          <View style={chevronStyle}>
            <ThemedChevron size={16} uniProps={gripColor} />
          </View>
          <View style={styles.content}>
            <Text style={settingsStyles.rowTitle}>{family.name}</Text>
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {familySummary(family)}
            </Text>
          </View>
        </Pressable>
        {/* A switch for a CLI that is installed nowhere would change nothing. */}
        <View style={styles.trailing}>
          {family.installed ? (
            <Switch
              value={family.enabled}
              onValueChange={toggle}
              disabled={busy}
              accessibilityLabel={`Enable ${family.name} everywhere`}
            />
          ) : null}
          {family.installed === false ? (
            <Button variant="outline" size="sm" onPress={toggleExpanded}>
              Show install command
            </Button>
          ) : null}
        </View>
      </View>
      {expanded ? (
        <View style={styles.detail} testID={`provider-family-detail-${family.id}`}>
          {family.installed === false ? (
            <View style={styles.command}>
              <Text selectable style={styles.commandText}>
                {providerInstallCommand(family.id) ?? providerInstallHint(family.id)}
              </Text>
              <Button variant="ghost" size="sm" onPress={copyCommand}>
                Copy
              </Button>
            </View>
          ) : (
            <SettingsExpansion>
              <ProviderDetail providerType={family.id} />
            </SettingsExpansion>
          )}
        </View>
      ) : null}
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
  const renderFamily = useCallback(
    ({ item, drag, dragHandleProps }: DraggableRenderItemInfo<ProviderFamily>) => (
      <ProviderFamilyCard
        family={item}
        snapshot={data}
        busy={change.isPending}
        save={change.mutate}
        expanded={item.id === expanded}
        onToggleExpanded={toggleExpanded}
        showDrag={
          item.installed === true &&
          families.filter((family) => family.installed === true && family.enabled === item.enabled)
            .length > 1
        }
        drag={drag}
        dragHandleProps={dragHandleProps}
      />
    ),
    [data, change, expanded, toggleExpanded, families],
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
  const noDrag = useCallback(() => undefined, []);
  return (
    <View>
      <SettingsSection
        title="Providers"
        status={change.isPending ? "Saving provider settings..." : null}
        info="Providers and their connections work in every environment. Expand a provider to manage its connections, profiles and model defaults. Drag installed providers to set their order in the picker."
      >
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
              onPress={toggleAvailable}
              accessibilityRole="button"
              accessibilityState={availableState}
              style={styles.heading}
              testID="shared-providers-available-toggle"
            >
              <ThemedChevron
                size={16}
                uniProps={gripColor}
                style={showAvailable ? styles.chevronExpanded : undefined}
              />
              <Text style={settingsStyles.rowTitle}>
                Available to install (
                {families.filter((family) => family.installed === false).length})
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
        <Button variant="outline" onPress={openAdd}>
          Add provider
        </Button>
      </SettingsSection>
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
          <Button variant="ghost" size="sm" onPress={switchTarget}>
            {`Install in ${environmentLabel(other)} instead`}
          </Button>
        ) : null}
      </AdaptiveModalSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  item: { marginVertical: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  title: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  titleHovered: { backgroundColor: theme.colors.surface2 },
  titleHover: hoverStyle({ backgroundColor: theme.colors.surface2 }),
  content: { flex: 1, minWidth: 120 },
  dragHandle: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  trailing: { width: 160, alignItems: "flex-end" },
  skeleton: { height: 96, padding: theme.spacing[3], justifyContent: "center" },
  command: { gap: theme.spacing[2] },
  commandText: { fontFamily: "monospace", color: theme.colors.foreground },
  detail: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
  },
}));

const loadingPane = { settingsLoading: "true" };
