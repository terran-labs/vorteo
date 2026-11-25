import { ExecutionEnvironmentIcon } from "@/execution-installation/environment-icon";
import { EnvironmentPresetMenu } from "./environment-preset-menu";
import { AccountDisconnectedIcon } from "@/provider-usage/reconnect-control";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { Text, View } from "react-native";
import { useWindowDimensions } from "@/appearance/interface-geometry";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Combobox, type ComboboxDesktopPlacement } from "@/components/ui/combobox";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePresetData } from "./use-preset-data";
import type { AgentProfilePicker } from "./internal/use-agent-profile-picker";
import { useAgentProfiles } from "./internal/use-agent-profiles";
import { NEW_WORKSPACE_CARD_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import { RemainingRing } from "@/provider-usage/remaining-ring";
import { useCompactProfileName } from "./use-compact-profile-name";
import { canonicalProfileId } from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { selectedPresetPresentation } from "./selected-preset-presentation";
import { effectiveReasoning } from "./shared-choices";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

const PROFILE_SNAP_POINTS = ["90%"];
const PendingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const EMPTY_OPTIONS: { id: string; label: string }[] = [];

function PresetStatusIcon({
  waiting,
  showWarning,
  showRing,
  remaining,
  stale,
}: {
  waiting: boolean;
  showWarning: boolean;
  showRing: boolean;
  remaining: number | null;
  stale: boolean;
}) {
  if (waiting) return <PendingSpinner size="small" style={styles.pendingRing} />;
  if (showWarning) return <AccountDisconnectedIcon />;
  if (showRing)
    return (
      <View style={styles.ring}>
        <RemainingRing remaining={remaining} stale={stale} />
      </View>
    );
  return null;
}

interface PresetControlsProps {
  inline?: boolean;
  serverId: string | null;
  profiles: AgentProfilePicker;
  selectedProfileId?: string;
  selectedProfileName?: string;
  activeProfileId?: string;
  currentProvider?: string;
  currentModel?: string | null;
  currentThinkingOptionId?: string | null;
  quotaPausedAt?: string;
  onEdit?: () => void;
  disabled: boolean;
  /** Opens the picker on behalf of an action outside the composer. */
  openRequested?: boolean;
  onOpenRequestHandled?: () => void;
  /**
   * Where the desktop picker opens. Above suits the composer at the bottom of the screen. "fit"
   * suits a control anywhere on a page: the picker opens on the side with room for all of it, or
   * else on the larger side, shortened to that side's space. Its detail list then scrolls inside
   * the picker while the Activate button stays in the window.
   */
  desktopPlacement?: ComboboxDesktopPlacement | "fit";
}

const PICKER_HEIGHT = 520;
// The combobox's collision padding and offset, so a fitted picker never touches the window edge.
const PICKER_MARGIN = 16;
/** The side and height a picker anchored at `top`..`bottom` fits in a window `windowHeight` tall. */
export function fitPresetPicker(input: { top: number; bottom: number; windowHeight: number }): {
  placement: ComboboxDesktopPlacement;
  height: number;
} {
  const below = input.windowHeight - input.bottom - PICKER_MARGIN;
  const above = input.top - PICKER_MARGIN;
  if (below >= PICKER_HEIGHT) return { placement: "bottom-start", height: PICKER_HEIGHT };
  if (above >= PICKER_HEIGHT) return { placement: "top-start", height: PICKER_HEIGHT };
  // The picker is portaled, so it never scrolls with the page: it must fit the side it opens on.
  const placement = below >= above ? "bottom-start" : "top-start";
  return { placement, height: Math.max(below, above) };
}
export function activePresetPicker(input: {
  enabled?: boolean;
  supported: boolean;
  picker: AgentProfilePicker | null;
}) {
  return input.enabled && input.supported ? input.picker : null;
}
/** The composer's live choices win; the selected profile fills anything not yet resolved. */
function selectedReasoning(input: {
  definition: AgentProfile | undefined;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  currentProvider?: string;
  currentModel?: string | null;
  currentThinkingOptionId?: string | null;
}) {
  const provider = input.currentProvider ?? input.definition?.provider;
  return effectiveReasoning({
    entry: input.entries?.find((entry) => entry.provider === provider),
    model: input.currentModel ?? input.definition?.model,
    thinkingOptionId: input.currentThinkingOptionId ?? input.definition?.thinkingOptionId,
  });
}

/** Opens the picker, first fitting it to the window when the placement is "fit". */
function usePickerFit(
  desktopPlacement: ComboboxDesktopPlacement | "fit",
  anchorRef: RefObject<View | null>,
  setOpen: (open: boolean) => void,
) {
  const { height: windowHeight } = useWindowDimensions();
  const [fitted, setFitted] = useState<ReturnType<typeof fitPresetPicker> | null>(null);
  const show = useCallback(() => {
    const anchor = anchorRef.current;
    if (desktopPlacement !== "fit" || !anchor) {
      setOpen(true);
      return;
    }
    anchor.measureInWindow((_x, y, _width, height) => {
      setFitted(fitPresetPicker({ top: y, bottom: y + height, windowHeight }));
      setOpen(true);
    });
  }, [anchorRef, desktopPlacement, setOpen, windowHeight]);
  if (desktopPlacement !== "fit")
    return { show, placement: desktopPlacement, height: PICKER_HEIGHT };
  return {
    show,
    placement: fitted?.placement ?? ("bottom-start" as const),
    height: fitted?.height ?? PICKER_HEIGHT,
  };
}

export function PresetControls({
  inline = false,
  serverId,
  profiles,
  selectedProfileId: storedProfileId,
  selectedProfileName,
  activeProfileId,
  currentProvider,
  currentModel,
  currentThinkingOptionId,
  disabled,
  openRequested = false,
  onOpenRequestHandled,
  desktopPlacement = "top-start",
}: PresetControlsProps) {
  const [openedHere, setOpenedHere] = useState(false);
  const open = openedHere || openRequested;
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenedHere(next);
      if (!next && openRequested) onOpenRequestHandled?.();
    },
    [openRequested, onOpenRequestHandled],
  );
  const panelActive = useRetainedPanelActive();
  const touch = useVortonTouch();
  const selectionDisabled = disabled || Boolean(profiles.isApplying);
  const controlsRef = useRef<View>(null);
  const triggerAccessibilityState = useMemo(
    () => ({ expanded: open, busy: Boolean(profiles.isApplying) }),
    [open, profiles.isApplying],
  );
  const [now, setNow] = useState(Date.now);
  const anchorRef = useRef<View>(null);
  const isCompact = useIsCompactFormFactor();
  const controlsStyle = useMemo(
    () => [
      styles.controls,
      touch && styles.touchControls,
      touch && isCompact && styles.centerControls,
    ],
    [touch, isCompact],
  );
  const { width } = useWindowDimensions();
  const { profiles: definitions, accountIndependent } = useAgentProfiles(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const { config } = useDaemonConfig(serverId);
  const preferences = config?.sharedProviderPreferences;
  const selectedProfileId =
    storedProfileId && preferences && accountIndependent
      ? canonicalProfileId(storedProfileId, preferences, config.providers)
      : storedProfileId;
  const hasLocalEndpoint = profiles.rows.some((row) => Boolean(row.localEndpoint));
  const active = panelActive;
  const { view, resetCounts } = usePresetData(serverId, active);
  // Refresh visible usage in the background without gating the menu.
  const refreshRef = useRef(profiles.refreshStatus);
  refreshRef.current = profiles.refreshStatus;
  const refreshingRef = useRef(profiles.isRefreshingStatus);
  refreshingRef.current = profiles.isRefreshingStatus;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (hasLocalEndpoint && !refreshingRef.current && timestamp - lastRefresh.current >= 60_000) {
        lastRefresh.current = timestamp;
        refreshRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [active, hasLocalEndpoint, serverId]);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active, setOpen]);
  const selected = profiles.rows.find((row) => row.id === selectedProfileId);
  const compactName = useCompactProfileName(controlsRef, isCompact);
  const reasoning = selectedReasoning({
    definition: definitions?.find((row) => row.id === selectedProfileId),
    entries,
    currentProvider,
    currentModel,
    currentThinkingOptionId,
  });
  const { triggerLabel, showWarning, showRing, remaining, statusLabel, accessibilityLabel } =
    selectedPresetPresentation({
      compactName,
      selectedProfileId,
      selectedProfileName,
      currentProvider,
      selected,
      definitions,
      entries,
      view,
      now,
      resetCounts,
      reasoningLabel: reasoning?.label,
    });
  const fit = usePickerFit(desktopPlacement, anchorRef, setOpen);
  const show = fit.show;
  const select = useCallback(
    (
      id: string,
      choices?: Partial<Pick<AgentProfile, "provider" | "model" | "thinkingOptionId">>,
    ) => {
      if (disabled || profiles.isApplying) return;
      profiles.applyProfile(id, choices);
      setOpen(false);
    },
    [disabled, profiles, setOpen],
  );
  const closeMenu = useCallback(() => setOpen(false), [setOpen]);
  if (inline)
    return (
      <View
        style={isCompact ? styles.inlineCompact : styles.inline}
        testID="new-workspace-profile-selector"
      >
        <EnvironmentPresetMenu
          inline
          now={now}
          serverId={serverId}
          profiles={profiles}
          selectedId={selectedProfileId}
          compact={isCompact}
          disabled={selectionDisabled}
          onApply={select}
          onClose={closeMenu}
          currentProvider={currentProvider}
          currentModel={currentModel}
          currentThinkingOptionId={currentThinkingOptionId}
        />
      </View>
    );
  return (
    <View ref={controlsRef} style={controlsStyle} testID="preset-controls">
      <View ref={anchorRef} collapsable={false} style={styles.trigger}>
        <ComboboxTrigger
          style={styles.toolbarTrigger}
          accessibilityRole="button"
          accessibilityState={triggerAccessibilityState}
          onPress={show}
          disabled={selectionDisabled}
          accessibilityLabel={accessibilityLabel}
          testID="agent-preset-selector"
        >
          <PresetStatusIcon
            waiting={Boolean(profiles.isApplying)}
            showWarning={showWarning}
            showRing={showRing}
            remaining={remaining}
            stale={Boolean(statusLabel)}
          />
          <ExecutionEnvironmentIcon serverId={serverId} />
          <Text style={styles.toolbarText} numberOfLines={1}>
            {triggerLabel}
          </Text>
        </ComboboxTrigger>
      </View>
      <Combobox
        options={EMPTY_OPTIONS}
        value={selectedProfileId ?? ""}
        onSelect={select}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        title=""
        mobileSnapPoints={PROFILE_SNAP_POINTS}
        desktopPlacement={fit.placement}
        desktopMinWidth={Math.min(1040, width - 32)}
        desktopFixedHeight={fit.height}
        desktopPreventInitialFlash
        desktopLockWidth
        desktopChildrenScrollEnabled={false}
        mobileChildrenScrollEnabled={false}
        keepOpenOnSelect
      >
        <EnvironmentPresetMenu
          now={now}
          key={`${open}-${isCompact}`}
          serverId={serverId}
          profiles={profiles}
          selectedId={selectedProfileId}
          activeProfileId={
            activeProfileId && preferences && accountIndependent
              ? canonicalProfileId(activeProfileId, preferences, config.providers)
              : activeProfileId
          }
          compact={isCompact}
          disabled={selectionDisabled}
          onApply={select}
          onClose={closeMenu}
          currentProvider={currentProvider}
          currentModel={currentModel}
          currentThinkingOptionId={currentThinkingOptionId}
        />
      </Combobox>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  inline: { height: NEW_WORKSPACE_CARD_HEIGHT, width: "100%" },
  inlineCompact: { height: 340, width: "100%" },
  touchControls: { flexShrink: 1, flexWrap: "nowrap" },
  centerControls: { justifyContent: "center", marginHorizontal: 8 },
  controls: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  trigger: { minWidth: 0, maxWidth: 360, flexShrink: 1 },
  toolbarText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  toolbarTrigger: {
    gap: theme.spacing[2],
    height: 28,
    minHeight: 28,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    borderWidth: 0,
    borderRadius: theme.borderRadius["2xl"],
  },
  pendingRing: { width: 28, height: 28, marginRight: theme.spacing[1] },
  ring: { marginRight: theme.spacing[1] },
}));
