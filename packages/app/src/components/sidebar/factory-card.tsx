import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Columns3, Factory, Pin, PinOff } from "lucide-react-native";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isNative } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import { useInstalledPlugins } from "@/plugins/registry";
import { loadFactoryQueue, type FactoryInvoke } from "@/screens/factory/queue";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { groupHoverStyle, hoverGroup, hoverStyle } from "@/styles/hover";
import { LIST_ROW_HEIGHT, LIST_ROW_TOUCH_HEIGHT } from "@/styles/list-row-metrics";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useVortonTouch } from "@/vorton-touch";
import { useProjectFactory } from "./factory-instructions";
import {
  factoryRunners,
  factoryStatePill,
  type FactoryCardModel,
  type FactoryQueueIssue,
  type FactoryStatePill,
} from "./factory-card-model";
import {
  factoryCardPassThrough,
  factoryCardSurfaceHover,
  whileFactoryCardHovered,
} from "./factory-card-hover";
import { FactoryRoleChips, factoryChips } from "./factory-card-roles";
import { FactoryRunners } from "./factory-card-runners";
import { FactoryStageBar } from "./factory-card-stage-bar";
import { useFactoryCardStore } from "./factory-card-store";
import type { ProjectFactoryState } from "./factory-state";
import { sidebarIndent } from "./indent";
import { factoryOverviewRoute } from "./project-factory-model";
import { useLongPressDragInteraction } from "./use-long-press-drag-interaction";

const ThemedFactory = withUnistyles(Factory);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedColumns = withUnistyles(Columns3);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pinIcon = <ThemedPin size={ICON_SIZE.sm} uniProps={mutedColor} />;
const unpinIcon = <ThemedPinOff size={ICON_SIZE.sm} uniProps={mutedColor} />;

/** The toggle's own hover group, which swaps the Factory glyph for the chevron. */
const TOGGLE_HOVER_GROUP = "factory-card-toggle";

/**
 * Queue refresh while the card's detail is visible. Each daemon read is a GitHub query on the
 * Foreman's token, so a collapsed card shows the last cached queue and fetches nothing.
 */
const DETAIL_REFRESH_MS = 120_000;

/**
 * Where the card's border sits: just outside the content inset, so the Factory icon shares the
 * icon rail of the workspace rows at the same level.
 */
const CARD_CONTENT_INSET = 10;

export interface FactoryCardProps {
  card: FactoryCardModel;
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /** Names the project when the card shows outside it, such as under Pinned. */
  projectName: string | null;
  level: number;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  selectionEnabled: boolean;
  canPinWorkspace: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  /** Lets a host surface such as the rail flyout close before navigation. */
  onWorkspacePress?: () => void;
}

/**
 * One project's Factory as a single sidebar card: state, queue stages, role chips and runners.
 *
 * The card surface is a pressable layer behind the content rather than around it, so the chips and
 * rows inside are never nested in another pressable and their hover replaces the card's.
 */
export const FactoryCard = memo(function FactoryCard({
  card,
  entries,
  projectName,
  level,
  activeWorkspaceSelection,
  selectionEnabled,
  canPinWorkspace,
  onToggleWorkspacePin,
  onWorkspacePress,
}: FactoryCardProps) {
  const { t } = useTranslation();
  const collapsed = useFactoryCardStore((state) => state.collapsed.includes(card.key));
  const toggleCollapsedKey = useFactoryCardStore((state) => state.toggleCollapsed);
  const toggleCollapsed = useCallback(
    () => toggleCollapsedKey(card.key),
    [toggleCollapsedKey, card.key],
  );
  const { plugin, route, openOverview } = useFactoryOverview(card, onWorkspacePress);
  const state = useProjectFactory(card.serverId, card.projectId, true).data;
  const { issues, setTooltipOpen } = useFactoryQueueIssues({ card, plugin, state, collapsed });

  const members = useMemo(
    () => card.members.flatMap((member) => entries.get(member.workspaceKey) ?? []),
    [card.members, entries],
  );
  const chips = useMemo(() => factoryChips(state?.roles, members), [state?.roles, members]);
  const runners = useMemo(() => (issues ? factoryRunners(issues) : []), [issues]);

  const interaction = useLongPressDragInteraction({ menuController: null });
  const handleSurfacePress = useCallback(() => {
    // A touch that turned into a scroll is not a press, as on ordinary sidebar rows.
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    openOverview();
  }, [interaction.didLongPressRef, openOverview]);
  const pill = state ? factoryStatePill(state) : null;

  return (
    <ContextMenu>
      {/* Right-click anywhere on the card, including the stage bar and runners, opens its menu;
          chips stop the event and open their workspace menu instead. */}
      <ContextMenuTrigger
        contextOnly
        style={[styles.card, cardInset(level)]}
        testID={`factory-card-${card.key}`}
        role="group"
        accessibilityLabel={t("sidebar.factoryCard.title")}
      >
        <ContextMenuTrigger
          accessibilityRole={route ? "link" : undefined}
          accessibilityLabel={t("sidebar.factoryCard.openOverview")}
          accessibilityHint={pill ? t(`sidebar.factoryCard.states.${pill.label}`) : undefined}
          accessible={Boolean(route)}
          style={styles.surface}
          highlightStyle={styles.surfacePressed}
          onPress={handleSurfacePress}
          onPressIn={interaction.handlePressIn}
          onPressOut={interaction.handlePressOut}
          onTouchMove={interaction.handleTouchMove}
          testID={`factory-card-surface-${card.key}`}
        />
        <View pointerEvents="box-none" style={styles.content}>
          <FactoryCardHeader
            cardKey={card.key}
            collapsed={collapsed}
            projectName={projectName}
            state={state}
            issues={issues}
            canOpenOverview={route !== null}
            onToggle={toggleCollapsed}
            onOpenOverview={openOverview}
            onTooltipOpenChange={setTooltipOpen}
          />
          {collapsed ? null : (
            <>
              {issues ? (
                <FactoryStageBar
                  issues={issues}
                  expanded
                  onOpenOverview={openOverview}
                  onTooltipOpenChange={setTooltipOpen}
                />
              ) : null}
              <FactoryRoleChips
                chips={chips}
                activeWorkspaceSelection={activeWorkspaceSelection}
                selectionEnabled={selectionEnabled}
                canPinWorkspace={canPinWorkspace}
                onToggleWorkspacePin={onToggleWorkspacePin}
                onWorkspacePress={onWorkspacePress}
              />
              <FactoryRunners
                serverId={card.serverId}
                runners={runners}
                onBeforeNavigate={onWorkspacePress}
              />
            </>
          )}
        </View>
      </ContextMenuTrigger>
      <FactoryCardMenu
        cardKey={card.key}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onOpenOverview={route ? openOverview : null}
      />
    </ContextMenu>
  );
});

/** The overview route, when this host's Factory plugin offers one. */
function useFactoryOverview(card: FactoryCardModel, onBeforeNavigate?: () => void) {
  const plugin = useInstalledPlugins().find(
    (entry) => entry.id === "factory" && entry.serverId === card.serverId,
  );
  const { installationId, serverId, projectId } = card;
  const route = useMemo(
    () =>
      installationId ? factoryOverviewRoute({ serverId, projectId, installationId }, plugin) : null,
    [installationId, serverId, projectId, plugin],
  );
  const openOverview = useCallback(() => {
    if (!route) return;
    onBeforeNavigate?.();
    router.navigate(route);
  }, [route, onBeforeNavigate]);
  return { plugin, route, openOverview };
}

/**
 * The queue behind the stage bar and runners. Null hides both: still loading, failed, or a daemon
 * without the queue. Detail views refresh faster than the collapsed bar.
 */
function useFactoryQueueIssues(input: {
  card: FactoryCardModel;
  plugin: { invoke: FactoryInvoke } | undefined;
  state: ProjectFactoryState | undefined;
  collapsed: boolean;
}) {
  const { card, plugin, state, collapsed } = input;
  const active = useRetainedPanelActive();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Only a running Factory changes its queue, and only an open card or tooltip shows the detail.
  const live = active && !!plugin && state?.state === "on" && (!collapsed || tooltipOpen);
  const queryKey = ["factoryQueue", card.serverId, card.projectId];
  // A card with nothing cached loads once, so a collapsed card still has a stage bar to show.
  const cached = useQueryClient().getQueryData(queryKey) !== undefined;
  const readable = active && !!plugin && !!state && state.state !== "off";
  // Shares the overview's cache, so opening either shows the other's latest queue.
  const queue = useFetchQuery({
    dataShape: "value",
    queryKey,
    staleTimeMs: 30_000,
    enabled: live || (readable && !cached),
    refetchInterval: (query) => (live && query.state.data !== null ? DETAIL_REFRESH_MS : false),
    queryFn: () => loadFactoryQueue(plugin!.invoke, card.projectId),
  });
  return { issues: queue.data?.issues ?? null, setTooltipOpen };
}

function FactoryCardHeader({
  cardKey,
  collapsed,
  projectName,
  state,
  issues,
  canOpenOverview,
  onToggle,
  onOpenOverview,
  onTooltipOpenChange,
}: {
  cardKey: string;
  collapsed: boolean;
  projectName: string | null;
  state: ProjectFactoryState | undefined;
  issues: FactoryQueueIssue[] | null;
  canOpenOverview: boolean;
  onToggle: () => void;
  onOpenOverview: () => void;
  onTooltipOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const touch = useVortonTouch() || isNative;
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.header,
        touch && styles.headerTouch,
        collapsed ? styles.headerCollapsed : styles.headerExpanded,
      ]}
    >
      <CollapseToggle collapsed={collapsed} touch={touch} onToggle={onToggle} />
      <View pointerEvents="none" style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {t("sidebar.factoryCard.title")}
          {projectName ? <Text style={styles.project}>{` · ${projectName}`}</Text> : null}
        </Text>
      </View>
      {state ? (
        <StatePill pill={factoryStatePill(state)} state={state} onPress={onOpenOverview} />
      ) : null}
      {collapsed && issues ? (
        <FactoryStageBar
          issues={issues}
          expanded={false}
          onOpenOverview={onOpenOverview}
          onTooltipOpenChange={onTooltipOpenChange}
        />
      ) : null}
      {!collapsed && canOpenOverview ? (
        <ToolbarButton
          label={t("sidebar.factoryCard.openOverview")}
          onPress={onOpenOverview}
          style={styles.overviewButton}
          testID={`factory-card-overview-${cardKey}`}
        >
          <ThemedColumns size={ICON_SIZE.sm} uniProps={mutedColor} />
        </ToolbarButton>
      ) : null}
    </View>
  );
}

function FactoryCardMenu({
  cardKey,
  collapsed,
  onToggleCollapsed,
  onOpenOverview,
}: {
  cardKey: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenOverview: (() => void) | null;
}) {
  const { t } = useTranslation();
  const pinned = useFactoryCardStore((state) => state.pinned.includes(cardKey));
  const togglePinnedKey = useFactoryCardStore((state) => state.togglePinned);
  const togglePinned = useCallback(() => togglePinnedKey(cardKey), [togglePinnedKey, cardKey]);
  return (
    <ContextMenuContent align="start" width={220} testID={`factory-card-menu-${cardKey}`}>
      <ContextMenuItem leading={pinned ? unpinIcon : pinIcon} onSelect={togglePinned}>
        {pinned ? t("sidebar.factoryCard.unpin") : t("sidebar.factoryCard.pin")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onToggleCollapsed}>
        {collapsed ? t("sidebar.factoryCard.expand") : t("sidebar.factoryCard.collapse")}
      </ContextMenuItem>
      {onOpenOverview ? (
        <ContextMenuItem onSelect={onOpenOverview}>
          {t("sidebar.factoryCard.openOverview")}
        </ContextMenuItem>
      ) : null}
    </ContextMenuContent>
  );
}

function cardInset(level: number) {
  return inlineUnistylesStyle({
    marginLeft: Math.max(2, sidebarIndent(level) - CARD_CONTENT_INSET),
  });
}

/**
 * The Factory icon is the collapse control. Where a pointer hovers, it turns into the chevron
 * under the pointer; on touch and compact layouts the chevron always shows.
 */
function CollapseToggle({
  collapsed,
  touch,
  onToggle,
}: {
  collapsed: boolean;
  touch: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = collapsed ? t("sidebar.factoryCard.expand") : t("sidebar.factoryCard.collapse");
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  const expandedState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={expandedState}
        aria-expanded={!collapsed}
        hitSlop={touch ? 12 : 4}
        onPress={onToggle}
        style={styles.toggle}
        testID="factory-card-toggle"
      >
        {touch ? (
          <Chevron size={ICON_SIZE.sm} uniProps={mutedColor} />
        ) : (
          <>
            <View style={styles.factoryGlyph}>
              <ThemedFactory size={ICON_SIZE.md} uniProps={mutedColor} />
            </View>
            <View style={styles.chevronGlyph}>
              <Chevron size={ICON_SIZE.sm} uniProps={mutedColor} />
            </View>
          </>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <TooltipText label={label} />
      </TooltipContent>
    </Tooltip>
  );
}

/** On, Paused, Draining or Off, with the daemon's reason on hover. */
function StatePill({
  pill,
  state,
  onPress,
}: {
  pill: FactoryStatePill;
  state: Pick<ProjectFactoryState, "reason" | "drain">;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const label = t(`sidebar.factoryCard.states.${pill.label}`);
  const reason = state.drain?.reason ?? state.reason ?? undefined;
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger
        accessible={false}
        focusable={false}
        tabIndex={-1}
        aria-hidden
        onPress={onPress}
        style={[styles.pill, styles.passThrough]}
        testID="factory-card-state"
      >
        <StatusBadge label={label} variant={pill.variant} size="xs" />
      </TooltipTrigger>
      <TooltipContent side="top" maxWidth={300}>
        <TooltipText label={label} description={reason} />
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  passThrough: { ...factoryCardPassThrough },
  card: {
    position: "relative",
    marginRight: 2,
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[1],
  },
  // The card's visible surface and its overview hit target. Hover only recolors the border.
  surface: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    ...factoryCardSurfaceHover({ borderColor: theme.colors.accent }),
  },
  surfacePressed: { borderColor: theme.colors.accent },
  content: { paddingBottom: 2 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: CARD_CONTENT_INSET - 2,
    paddingRight: theme.spacing[1],
  },
  headerTouch: { minHeight: LIST_ROW_TOUCH_HEIGHT },
  headerExpanded: {
    minHeight: 36,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
    marginBottom: theme.spacing[1],
  },
  headerCollapsed: { minHeight: LIST_ROW_HEIGHT, paddingRight: CARD_CONTENT_INSET },
  titleRow: { flexShrink: 1, minWidth: 0 },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  project: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  pill: { marginLeft: "auto", flexShrink: 0 },
  toggle: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    ...hoverGroup(
      TOGGLE_HOVER_GROUP,
      hoverStyle({ backgroundColor: theme.colors.interactionHighlight })._web,
    ),
  },
  factoryGlyph: groupHoverStyle(TOGGLE_HOVER_GROUP, { display: "none" }),
  chevronGlyph: {
    display: "none",
    ...groupHoverStyle(TOGGLE_HOVER_GROUP, { display: "flex" }),
  },
  overviewButton: whileFactoryCardHovered({
    backgroundColor: theme.colors.interactionHighlight,
  }),
}));
