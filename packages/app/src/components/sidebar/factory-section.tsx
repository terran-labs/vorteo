import { SidebarDisclosureBody } from "./disclosure-body";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { router, usePathname } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Pin, PinOff } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import { useInstalledPlugins } from "@/plugins/registry";
import {
  factoryQueueRefreshInterval,
  loadFactoryQueue,
  type FactoryInvoke,
  type FactoryQueue,
} from "@/screens/factory/queue";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useProjectFactory } from "./factory-instructions";
import {
  factoryOverviewPathTarget,
  factoryRunners,
  factoryStatePill,
  factoryStateReason,
  type FactoryCardModel,
  type FactoryStatePill,
} from "./factory-card-model";
import {
  FactoryForemanTile,
  FactoryRoleChips,
  factoryChips,
  splitForeman,
} from "./factory-card-roles";
import { FactoryRunners } from "./factory-card-runners";
import { FactoryStageBar, type StageBarIssue } from "./factory-card-stage-bar";
import { useFactoryCardStore } from "./factory-card-store";
import type { ProjectFactoryState } from "./factory-state";
import { FactorySubheading } from "./factory-subheading";
import { SidebarSectionRow } from "./container-row";
import { SidebarFactoryIcon } from "./leading-slot";
import { factoryOverviewRoute } from "./project-factory-model";

const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pinIcon = <ThemedPin size={ICON_SIZE.sm} uniProps={mutedColor} />;
const unpinIcon = <ThemedPinOff size={ICON_SIZE.sm} uniProps={mutedColor} />;
// Calm like the Pinned and Standing glyphs beside it.
const factoryIcon = <SidebarFactoryIcon calm cssHover />;
const SELECTED_STATE = { selected: true };

export interface FactorySectionProps {
  card: FactoryCardModel;
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /** Names the project when the section shows outside it, such as under Pinned. */
  projectName: string | null;
  /** The Factory row's level; its subheadings sit one further in and their items two. */
  level: number;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  selectionEnabled: boolean;
  canPinWorkspace: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  /** Lets a host surface such as the rail flyout close before navigation. */
  onWorkspacePress?: () => void;
}

/**
 * One project's Factory as a folder-like section, styled like Standing: the Factory row, then the
 * Foreman to talk to, its crew and the runners, indented under it without a card or dividers.
 */
export const FactorySection = memo(function FactorySection({
  card,
  entries,
  projectName,
  level,
  activeWorkspaceSelection,
  selectionEnabled,
  canPinWorkspace,
  onToggleWorkspacePin,
  onWorkspacePress,
}: FactorySectionProps) {
  const { t } = useTranslation();
  const collapsed = useFactoryCardStore((state) => state.collapsed.includes(card.key));
  const { plugin, route, openOverview } = useFactoryOverview(card, onWorkspacePress);
  const routeTarget = factoryOverviewPathTarget(usePathname());
  const state = useProjectFactory(card.serverId, card.projectId, true).data;
  const issues = useFactoryQueueIssues({ card, plugin, state, collapsed });

  const members = useMemo(
    () => card.members.flatMap((member) => entries.get(member.workspaceKey) ?? []),
    [card.members, entries],
  );
  const { foreman, crew } = useMemo(
    () => splitForeman(factoryChips(state?.roles, members)),
    [state?.roles, members],
  );
  const runners = useMemo(() => (issues ? factoryRunners(issues) : []), [issues]);
  const pill = useMemo(
    () =>
      state ? { pill: factoryStatePill(state), description: factoryStateReason(state, t) } : null,
    [state, t],
  );
  const selection = {
    activeWorkspaceSelection,
    selectionEnabled,
    canPinWorkspace,
    onToggleWorkspacePin,
    onWorkspacePress,
  };

  return (
    <FactorySectionRow
      sectionKey={card.key}
      level={level}
      title={
        projectName
          ? t("sidebar.factoryCard.titleWithProject", { project: projectName })
          : t("sidebar.factoryCard.title")
      }
      pill={pill}
      issues={issues}
      onOpenOverview={route ? openOverview : null}
      selected={routeTarget?.serverId === card.serverId && routeTarget.projectId === card.projectId}
      pinnable
    >
      {foreman ? <FactoryForemanTile chip={foreman} level={level + 1} {...selection} /> : null}
      {crew.length > 0 ? (
        <>
          <FactorySubheading label={t("sidebar.factoryCard.crew")} level={level + 1} />
          <FactoryRoleChips chips={crew} level={level + 2} {...selection} />
        </>
      ) : null}
      <FactoryRunners
        serverId={card.serverId}
        runners={runners}
        level={level + 1}
        onBeforeNavigate={onWorkspacePress}
      />
    </FactorySectionRow>
  );
});

export interface FactorySectionPill {
  pill: FactoryStatePill;
  /** The pill's tooltip detail, such as the daemon's reason. */
  description?: string;
}

/**
 * The folding row both Factory sections share, built on the Pinned and Standing section row: the
 * row folds its contents, and the Overview button at its right edge opens the overview.
 */
export function FactorySectionRow({
  sectionKey,
  level,
  title,
  pill,
  issues,
  onOpenOverview,
  selected,
  pinnable,
  children,
}: {
  /** Fold (and pin) state key in the device store. */
  sectionKey: string;
  level: number;
  title: string;
  pill: FactorySectionPill | null;
  /** Null hides the stage bar. */
  issues: readonly StageBarIssue[] | null;
  /** Null when there is no overview to open. */
  onOpenOverview: (() => void) | null;
  /** The section's overview is the current page, marked like the selected sidebar row. */
  selected: boolean;
  pinnable: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const collapsed = useFactoryCardStore((state) => state.collapsed.includes(sectionKey));
  const toggleCollapsedKey = useFactoryCardStore((state) => state.toggleCollapsed);
  const toggleCollapsed = useCallback(
    () => toggleCollapsedKey(sectionKey),
    [toggleCollapsedKey, sectionKey],
  );
  const accessory = useMemo(
    () => (
      <View style={styles.accessory}>
        {pill ? <StatePill pill={pill} onPress={toggleCollapsed} /> : null}
        {issues ? <FactoryStageBar issues={issues} onPress={toggleCollapsed} /> : null}
        {onOpenOverview ? (
          <Button
            variant="outline"
            size="sm"
            onPress={onOpenOverview}
            accessibilityLabel={t("sidebar.factoryCard.openOverview")}
            accessibilityState={selected ? SELECTED_STATE : undefined}
            aria-current={selected ? "page" : undefined}
            testID={`factory-section-overview-${sectionKey}`}
            style={styles.overviewButton}
            hitSlop={overviewHitSlop}
          >
            {t("sidebar.factoryCard.overview")}
          </Button>
        ) : null}
      </View>
    ),
    [pill, issues, onOpenOverview, selected, sectionKey, t, toggleCollapsed],
  );
  return (
    <>
      <ContextMenu>
        {/* Right-click the row for Pin, fold and the overview. */}
        <ContextMenuTrigger contextOnly testID={`factory-card-${sectionKey}`}>
          <SidebarSectionRow
            title={title}
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            level={level}
            icon={factoryIcon}
            accessory={accessory}
            selected={selected}
            testID={`factory-section-${sectionKey}`}
          />
        </ContextMenuTrigger>
        <FactorySectionMenu
          sectionKey={sectionKey}
          collapsed={collapsed}
          pinnable={pinnable}
          onToggleCollapsed={toggleCollapsed}
          onOpenOverview={onOpenOverview}
        />
      </ContextMenu>
      <SidebarDisclosureBody expanded={!collapsed}>{children}</SidebarDisclosureBody>
    </>
  );
}

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
 * Each queue read is a GitHub read on the Foreman's token, so sidebar cards read it only while
 * expanded on a running Factory, and slowly. Collapsed or paused cards show the last cached queue.
 */

/** Whether a sidebar card may read a Factory's queue now. */
export function factoryCardReadsQueue(input: {
  active: boolean;
  collapsed: boolean;
  state: Pick<ProjectFactoryState, "state" | "drain"> | undefined;
}): boolean {
  return input.active && !input.collapsed && input.state?.state === "on" && !input.state.drain;
}

/**
 * The queue behind the stage bar and runners, shared with the overview's cache. Null hides both:
 * not read yet, failed, or a daemon without the queue.
 */
function useFactoryQueueIssues(input: {
  card: FactoryCardModel;
  plugin: { invoke: FactoryInvoke } | undefined;
  state: ProjectFactoryState | undefined;
  collapsed: boolean;
}) {
  const { card, plugin, state, collapsed } = input;
  const active = useRetainedPanelActive();
  const queryKey = ["factoryQueue", card.serverId, card.projectId];
  // A card with nothing read yet reads once, so a collapsed or paused card still has a stage bar.
  // A failed or empty one-off read counts as read: it is not retried until the card polls.
  const queryClient = useQueryClient();
  const read = queryClient.getQueryState(queryKey) !== undefined;
  const refreshing = queryClient.getQueryData<FactoryQueue | null>(queryKey)?.refreshing === true;
  const readable = active && !!plugin && !!state && state.state !== "off";
  const polling = !!plugin && factoryCardReadsQueue({ active, collapsed, state });
  const queue = useFetchQuery({
    dataShape: "value",
    queryKey,
    staleTimeMs: 30_000,
    enabled: polling || (readable && !read) || (active && refreshing),
    retry: polling ? undefined : false,
    // A daemon without the queue answers null; never poll it again.
    refetchInterval: (query) =>
      factoryQueueRefreshInterval({ queue: query.state.data, enabled: active, polling }),
    queryFn: () => loadFactoryQueue(plugin!.invoke, card.projectId),
  });
  return queue.data?.issues ?? null;
}

function FactorySectionMenu({
  sectionKey,
  collapsed,
  pinnable,
  onToggleCollapsed,
  onOpenOverview,
}: {
  sectionKey: string;
  collapsed: boolean;
  pinnable: boolean;
  onToggleCollapsed: () => void;
  onOpenOverview: (() => void) | null;
}) {
  const { t } = useTranslation();
  const pinned = useFactoryCardStore((state) => state.pinned.includes(sectionKey));
  const togglePinnedKey = useFactoryCardStore((state) => state.togglePinned);
  const togglePinned = useCallback(
    () => togglePinnedKey(sectionKey),
    [togglePinnedKey, sectionKey],
  );
  return (
    <ContextMenuContent align="start" width={220} testID={`factory-card-menu-${sectionKey}`}>
      {pinnable ? (
        <ContextMenuItem leading={pinned ? unpinIcon : pinIcon} onSelect={togglePinned}>
          {pinned ? t("sidebar.factoryCard.unpin") : t("sidebar.factoryCard.pin")}
        </ContextMenuItem>
      ) : null}
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

/** On, Paused, Stopped or Held for update, with detail on hover. */
function StatePill({ pill, onPress }: { pill: FactorySectionPill; onPress: () => void }) {
  const { t } = useTranslation();
  const label = t(`sidebar.factoryCard.states.${pill.pill.label}`);
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger
        accessible={false}
        focusable={false}
        tabIndex={-1}
        aria-hidden
        onPress={onPress}
        style={styles.pill}
        testID="factory-card-state"
      >
        <StatusBadge label={label} variant={pill.pill.variant} size="xs" />
      </TooltipTrigger>
      <TooltipContent side="top" maxWidth={320}>
        <TooltipText label={label} description={pill.description} />
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  overviewButton: { height: 28, minHeight: 28, paddingVertical: 0 },
  accessory: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  pill: { flexShrink: 0 },
}));

const overviewHitSlop = { top: 8, bottom: 8 };
