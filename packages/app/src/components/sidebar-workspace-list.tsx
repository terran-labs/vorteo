import { SidebarDisclosureBody } from "./sidebar/disclosure-body";
import { ProjectMenuItem, type ProjectMenuSurface } from "./sidebar/project-menu-item";
import { FactoryProjectActions } from "./sidebar/factory-project-actions";
import { FactorySection } from "./sidebar/factory-section";
import { AllFactoriesSection } from "./sidebar/factory-all-section";
import { factoryCardModels } from "./sidebar/factory-card-model";
import { useFactoryCardStore } from "./sidebar/factory-card-store";
import { FactoryInstructionsPanel, useProjectFactories } from "./sidebar/factory-instructions";
import { ProjectFactoryDialog } from "./sidebar/project-factory";
import { projectFactoryTargets } from "./sidebar/project-factory-model";
import { hasActiveSidebarLabelFilter } from "@/stores/sidebar-view-store";
import { useScrollReporter } from "./use-scroll-divider";
import { NestableScrollDivider } from "./nestable-scroll-divider";
import { splitFactoryWorkspaces } from "@/workspace/lifecycle/grouping";
import { useWorkspaceSessionMenu } from "@/workspace/use-workspace-session-menu";
import { useWorkspaceMenuActions } from "@/workspace/use-workspace-menu-actions";
import {
  ProjectMoveProvider,
  ProjectDropTarget,
  useWorkspaceProjectDrop,
} from "@/workspace/project-move/drop-context";
import { SidebarCountBadge } from "@/components/sidebar/sidebar-count-badge";
import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";

import { useSidebarActionSize } from "./sidebar/use-sidebar-action-size";
import { DiffStat } from "@/components/diff-stat";
import { aggregateProjectTasks, type ProjectTaskSummary } from "./sidebar/project-task-summary";
import { useVortonTouch, VORTON_ACTION_SLOT } from "@/vorton-touch";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  View,
  Text,
  Pressable,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type MutableRefObject,
  type Ref,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { router, usePathname } from "expo-router";
import { useSidebarNewWorkspaceRoute } from "@/hooks/use-sidebar-new-workspace-route";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { density as densityTokens, densityIconBox, densityIconProps } from "@/styles/density";
import {
  groupHoverStyle,
  hoverGroup,
  hoverStyle,
  hoverSurface,
  revealOnGroupHover,
  rowSurface,
} from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { type GestureType } from "react-native-gesture-handler";
import { WorkspaceRenameModal } from "@/components/workspace-rename-modal";
import {
  ExternalLink,
  Settings,
  MoreVertical,
  Plus,
  Trash2,
  LockKeyhole,
  FolderInput,
  FolderPlus,
} from "lucide-react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import {
  useSidebarWorkspacePinController,
  type ToggleSidebarWorkspacePin,
} from "@/hooks/use-sidebar-workspace-pin";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useInstalledPlugins } from "@/plugins/registry";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useIsSystemProjectOnAnyHost } from "@/workspace/lifecycle/system-membership";
import { useProjectIcons } from "@/projects/icons";
import {
  buildProjectSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  shouldShowSidebarHostLabels,
  useSidebarProjectStatusBucket,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import { useShowShortcutBadges } from "@/hooks/use-show-shortcut-badges";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  useContextMenu,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { ProjectLeadingVisual } from "@/components/sidebar/project-leading-visual";
import { SIDEBAR_LEADING_HOVER_GROUP } from "@/components/sidebar/leading-slot";
import { useToast } from "@/contexts/toast-context";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { SidebarStatusWorkspaceList } from "@/components/sidebar/sidebar-status-list";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import {
  SidebarWorkspaceContextMenu,
  SidebarWorkspaceMenu,
} from "@/components/sidebar/sidebar-workspace-menu";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";

import {
  useLimitedSidebarGroup,
  useLimitedSidebarTreeGroup,
  useLimitedSidebarTreeRows,
} from "@/components/sidebar/use-limited-sidebar-group";
import {
  sidebarWorkspaceRowStyles,
  SIDEBAR_WORKSPACE_HOVER_GROUP,
  sidebarMenuBackdrop,
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  SidebarWorkspaceShortcutBadge,
  resolveTrailingActionVisibility,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceMenuReveal,
  SidebarWorkspaceTrailingActionSlot,
  SidebarWorkspaceTrailingDetails,
  SIDEBAR_CALM_OPACITY,
  isSidebarRowCalm,
} from "@/components/sidebar/sidebar-workspace-row-content";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import {
  SidebarFilterEmptyState,
  SidebarProjectEmptyState,
} from "@/components/sidebar/empty-states";
import { selectWorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import {
  SidebarWorkspaceTrailingContent,
  useSidebarWorkspaceTrailing,
} from "@/components/sidebar/workspace-trailing";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipText } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { PrHint } from "@/git/use-pr-status-query";
import {
  buildSidebarProjectRowModel,
  resolveSidebarProjectLocalPath,
  type SidebarProjectHostTarget,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  getCurrentProjectRemoveReadiness,
  removeProjectFromHosts,
} from "@/projects/project-remove";
import { isNative as platformIsNative, isWeb, getIsElectron } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { OpenInFileManagerMenuItem } from "@/workspace/open-in-file-manager/menu-item";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import type { HostBadgeModel } from "@/hosts/appearance";
import { useHostBadges } from "@/hosts/use-host-badges";
import { useSidebarRowItems } from "@/components/sidebar/display-preferences/model";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import {
  placeSidebarEntry,
  reorderSidebarRows,
  useCreateSidebarFolderAction,
  useMoveToSidebarFolderAction,
  useSidebarFoldersSupported,
} from "@/sidebar-folders/actions";
import { SidebarFolderMenuButton, SidebarFolderRow } from "@/sidebar-folders/folder-row";
import { sidebarFolderEntry } from "@getpaseo/protocol/sidebar-folders";
import {
  SIDEBAR_ROW_INSET,
  sidebarIndentStyle,
  sidebarNestingStyle,
} from "@/components/sidebar/indent";
import { SidebarSectionRow } from "@/components/sidebar/container-row";
import { PinnedSectionRow } from "@/components/sidebar/pinned-section-row";
import { SidebarFocusButton } from "@/sidebar-focus/focus-button";
import { reorderKeys, useSidebarTreeDrop } from "@/sidebar-drop/tree-drop";
import {
  describeRootRow,
  folderIdOfEntry,
  projectDropTop,
  projectFolderDropTop,
  sectionDropTop,
  sectionWorkspaceDescriber,
  treeRowExternalDrop,
  workRowDescriber,
} from "@/sidebar-drop/rows";
import type { SidebarDropPlacement, SidebarDropRow } from "@/sidebar-drop/resolve";
import {
  dragViewCollapsedProjects,
  dragViewFolderState,
  useSidebarDragSession,
} from "@/sidebar-drop/session";
import { SidebarFocusBreadcrumb } from "@/sidebar-focus/breadcrumb";
import { useSidebarListReachReporter } from "@/components/sidebar/list-reach";
import {
  SidebarFocusProvider,
  useSidebarFocusAction,
  useSidebarFocusController,
  useSidebarRowFocus,
  type SidebarRowFocus,
} from "@/sidebar-focus/context";
import {
  buildSidebarFocusWorld,
  expandSidebarFocusPath,
  focusTreeRows,
  isSidebarSectionShown,
  sidebarFocusProjectKey,
  sidebarFocusRootDropTop,
  sidebarFocusRootRows,
  sidebarProjectBlockLevels,
  sidebarFocusRootLevelOffset,
  sidebarFocusTrail,
  type SidebarFocusSection,
  type SidebarFocusTarget,
  type SidebarFocusWorld,
  type SidebarProjectBlockFocus,
} from "@/sidebar-focus/model";
import {
  EMPTY_SIDEBAR_FOLDER_STATE,
  useSidebarFolderStore,
  type SidebarFolderState,
} from "@/sidebar-folders/store";
import {
  ROOT_FOLDER_SCOPE,
  buildSidebarTreeRows,
  projectFolderScope,
  savedSidebarAnchor,
  sidebarEntryParent,
  type SidebarTreeRow,
} from "@/sidebar-folders/tree";

const workspaceKeyExtractor = (workspace: SidebarWorkspacePlacement) => workspace.workspaceKey;

const projectViewKeyExtractor = (project: SidebarProjectEntry) => project.viewKey;

function treeRowKeyExtractor<T>(row: SidebarTreeRow<T>): string {
  return row.key;
}

function treeRowItems<T>(rows: readonly SidebarTreeRow<T>[]): T[] {
  return rows.flatMap((row) => (row.kind === "item" ? [row.item] : []));
}

const WORKSPACE_STATUS_DOT_WIDTH = 14;
// A project's direct children (workspaces, folders, Standing, Factory) sit one level in; the
// workspaces inside Standing, Factory and project folders sit one level further per step.
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedPlus = withUnistyles(Plus);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedLock = withUnistyles(LockKeyhole);
const ThemedSettings = withUnistyles(Settings);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedFolderInput = withUnistyles(FolderInput);

const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
/**
 * On web an icon strokes with its container's CSS color, so the container's CSS hover recolors
 * it. Native has no hover and keeps the muted color.
 */
const currentColorMapping = isWeb ? () => ({ color: "currentColor" }) : foregroundMutedColorMapping;

/** CSS hover groups. Nested groups need distinct names; see docs/hover.md. */
const PROJECT_ROW_HOVER_GROUP = "sidebar-project";
const PR_BADGE_HOVER_GROUP = "sidebar-pr-badge";
const NEW_WORKSPACE_ROW_HOVER_GROUP = "sidebar-new-workspace";

function isWorkspaceSelected(input: {
  selection: ActiveWorkspaceSelection | null;
  serverId: string | null;
  workspaceId: string;
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.selection?.serverId === input.serverId &&
    input.selection.workspaceId === input.workspaceId
  );
}

function isProjectSelectedByRoute(input: {
  selection: ActiveWorkspaceSelection | null;
  project: SidebarProjectEntry;
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.project.workspaces.some(
      (workspace) =>
        workspace.serverId === input.selection?.serverId &&
        workspace.workspaceId === input.selection.workspaceId,
    )
  );
}

function activeWorkspaceSelectionKey(selection: ActiveWorkspaceSelection | null): string {
  return selection ? `${selection.serverId}:${selection.workspaceId}` : "";
}

interface SidebarWorkspaceListProps {
  /** Project flyouts fit short lists while retaining the shared scrolling list. */
  onContentSizeChange?: (width: number, height: number) => void;
  onScrolledChange?: (scrolled: boolean) => void;
  workspaceGroups: SidebarWorkspaceGroup[];
  /** What `useProjectIcons` is asked for, straight from the projection. See `SidebarProjection`. */
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  /** Whether a project filter is actually being applied — the resolved list, not the stored one. */
  hasActiveProjectFilter: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  collapsedProjectKeys: ReadonlySet<string>;
  onToggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  groupMode: SidebarGroupMode;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  onWorkspacePress?: () => void;
  onAddProject?: () => void;
  onImportSession?: () => void;
  listFooterComponent?: ReactElement | null;
  // Navigation scrolls before both pinned items and the workspace section header.
  listTopComponent?: ReactElement | null;
  // Rendered below the Pinned section and above the workspace list.
  listHeaderComponent?: ReactElement | null;
  /** Gesture ref for coordinating with parent gestures (e.g., sidebar close) */
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
  /** False where the list shows a single project, such as the compact rail's flyout. */
  rootFolders?: boolean;
  /**
   * Where focus shows in another list, as from the compact rail's flyout: Focus buttons focus
   * their item in the sidebar's store, then call this so the sidebar can show it.
   */
  onFocusElsewhere?: () => void;
}

interface ProjectHeaderRowProps {
  taskSummary?: ProjectTaskSummary;
  project: SidebarProjectEntry;
  displayName: string;
  iconDataUri: string | null;
  statusBucket: SidebarStateBucket | null;
  selected?: boolean;
  chevron: "expand" | "collapse" | null;
  onPress: () => void;
  worktreeTarget: SidebarProjectHostTarget | null;
  isProjectActive?: boolean;
  onWorkspacePress?: () => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  shortcutNumber?: number | null;
  showShortcutBadge?: boolean;
  drag: () => void;
  isDragging: boolean;
  isArchiving?: boolean;
  menuController: ReturnType<typeof useContextMenu> | null;
  onRemoveProject?: () => void;
  removeProjectStatus?: "idle" | "pending";
  /** Shown on a disabled Remove item when the project cannot be removed. */
  removeProjectBlockedReason?: string | null;
  dragHandleProps?: DraggableListDragHandleProps;
}

interface WorkspaceRowInnerProps {
  workspace: SidebarWorkspaceEntry;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging: boolean;
  isArchiving: boolean;
  isCreating?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  menuController: ReturnType<typeof useContextMenu> | null;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  reserveIdleStatusIndicatorSpace?: boolean;
  /** Hierarchy level inside project mode; see `sidebarIndent`. */
  indentLevel?: number;
}

export function PrBadge({ hint, style }: { hint: PrHint; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );

  // Callers that place the badge in a list of icon+text rows pass that row's layout in, so the
  // icon and text land on the same rails as their neighbors instead of on the badge's tighter
  // inline spacing.
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      prBadgeStyles.badge,
      style,
      pressed && prBadgeStyles.badgePressed,
    ],
    [style],
  );

  const presentation = getForgePresentation(normalizeForge(hint.forge));

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: hint.number,
        context: presentation.changeRequestContext,
      })}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      style={pressableStyle}
    >
      {/* Both icons stay mounted; CSS swaps the state icon for the link icon on hover. */}
      <View style={prBadgeStyles.hideOnHover}>
        <PullRequestStateIcon state={hint.state} size={12} />
      </View>
      <View style={prBadgeStyles.showOnHover}>
        <ThemedExternalLink size={12} uniProps={foregroundColorMapping} />
      </View>
      <Text style={prBadgeStyles.text} numberOfLines={1}>
        {hint.number}
      </Text>
    </Pressable>
  );
}

function getProjectWorkspaceRowStyle({
  isDragging,
  isPressed,
  selected,
  hoverable,
}: {
  isDragging: boolean;
  isPressed: boolean;
  selected: boolean;
  hoverable: boolean;
}) {
  // CSS hover outranks the base class, so the selected, dragging and pressed fills win by
  // leaving the hover fill out.
  return [
    styles.workspaceRow,
    hoverable && !selected && !isDragging && !isPressed && styles.workspaceRowHoverable,
    selected && styles.sidebarRowSelected,
    isDragging && styles.workspaceRowDragging,
    isPressed && styles.workspaceRowPressed,
  ];
}

const prBadgeStyles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    ...hoverGroup(PR_BADGE_HOVER_GROUP),
  },
  hideOnHover: groupHoverStyle(PR_BADGE_HOVER_GROUP, { display: "none" }),
  // Hidden on native and touch web, which never showed the link icon.
  showOnHover: {
    display: "none",
    ...groupHoverStyle(PR_BADGE_HOVER_GROUP, { display: "flex" }),
  },
  badgePressed: {
    opacity: 0.82,
  },
  text: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
    ...groupHoverStyle(PR_BADGE_HOVER_GROUP, { color: theme.colors.foreground }),
  },
}));

function ProjectRowTrailingActions({
  projectViewKey,
  displayName,
  worktreeTarget,
  settingsTarget,
  projectPath,
  isMobileBreakpoint,
  isProjectActive,
  expanded,
  onBeginWorkspaceSetup,
  onRemoveProject,
  removeProjectStatus,
  removeProjectBlockedReason,
  focus,
}: {
  projectViewKey: string;
  displayName: string;
  worktreeTarget: SidebarProjectHostTarget | null;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
  focus: SidebarRowFocus;
  isMobileBreakpoint: boolean;
  isProjectActive: boolean;
  expanded: boolean;
  onBeginWorkspaceSetup: () => void;
  onRemoveProject?: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
  removeProjectBlockedReason?: string | null;
}) {
  const vortonTouch = useVortonTouch();

  // Touch and compact layouts have no hover, so their actions always show. Elsewhere CSS reveals
  // them while the project row is hovered; an expanded project keeps New workspace shown.
  const menuAlwaysShown = platformIsNative || isMobileBreakpoint || vortonTouch;
  const actionsAlwaysShown = expanded || menuAlwaysShown;
  return (
    <View style={[styles.projectTrailingActions, styles.projectTrailingActionsVorton]}>
      {worktreeTarget ? (
        <NewWorktreeButton
          displayName={displayName}
          onPress={onBeginWorkspaceSetup}
          revealOnHover={!actionsAlwaysShown}
          showShortcutHint={isProjectActive}
          testID={`sidebar-project-new-worktree-${projectViewKey}`}
        />
      ) : null}
      {onRemoveProject ? (
        <View style={!menuAlwaysShown && styles.projectActionReveal}>
          <ProjectKebabMenu
            projectViewKey={projectViewKey}
            projectName={displayName}
            settingsTarget={settingsTarget}
            projectPath={projectPath}
            onRemoveProject={onRemoveProject}
            removeProjectStatus={removeProjectStatus}
            removeProjectBlockedReason={removeProjectBlockedReason}
          />
        </View>
      ) : null}
      {focus.buttonAction ? (
        <SidebarFocusButton
          name={displayName}
          onPress={focus.buttonAction}
          testID={`sidebar-project-focus-${projectViewKey}`}
        />
      ) : null}
    </View>
  );
}

const trash2LeadingIcon = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;
const lockedLeadingIcon = <ThemedLock size={14} uniProps={foregroundMutedColorMapping} />;
const settingsLeadingIcon = <ThemedSettings size={14} uniProps={foregroundMutedColorMapping} />;
const newFolderLeadingIcon = <ThemedFolderPlus size={14} uniProps={foregroundMutedColorMapping} />;
const moveToFolderLeadingIcon = (
  <ThemedFolderInput size={14} uniProps={foregroundMutedColorMapping} />
);
const openInNewWindowLeadingIcon = (
  <ThemedExternalLink size={14} uniProps={foregroundMutedColorMapping} />
);

const kebabTriggerIcon = (
  <ThemedMoreVertical uniProps={densityIconProps("sm", currentColorMapping)} />
);

function ProjectKebabMenu({
  projectViewKey,
  projectName,
  settingsTarget,
  projectPath,
  onRemoveProject,
  removeProjectStatus,
  removeProjectBlockedReason,
}: {
  projectViewKey: string;
  projectName: string;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
  removeProjectBlockedReason?: string | null;
}) {
  const { t } = useTranslation();
  const actionSize = useSidebarActionSize();
  const actionStyle = useMemo(() => [styles.projectKebabButton, actionSize], [actionSize]);
  return (
    <DropdownMenu compactMode="sheet">
      <Tooltip enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            hitSlop={actionSize ? 0 : 8}
            style={actionStyle}
            accessibilityRole="button"
            accessibilityLabel={t("sidebar.project.actions.menu")}
            testID={`sidebar-project-kebab-${projectViewKey}`}
          >
            {kebabTriggerIcon}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <TooltipText label={t("sidebar.project.actions.menu")} />
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" width={220} sheetTitle={t("sidebar.project.actions.menu")}>
        <ProjectMenuItems
          surface="dropdown"
          projectViewKey={projectViewKey}
          projectName={projectName}
          settingsTarget={settingsTarget}
          projectPath={projectPath}
          onRemoveProject={onRemoveProject}
          removeProjectStatus={removeProjectStatus}
          removeProjectBlockedReason={removeProjectBlockedReason}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectMenuItems({
  surface,
  projectViewKey,
  projectName,
  settingsTarget,
  projectPath,
  onRemoveProject,
  removeProjectStatus,
  removeProjectBlockedReason,
}: {
  surface: ProjectMenuSurface;
  projectViewKey: string;
  projectName: string;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
  removeProjectBlockedReason?: string | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const plugins = useInstalledPlugins();
  const factoryPlugin = plugins.find(
    (plugin) => plugin.id === "factory" && plugin.serverId === settingsTarget?.serverId,
  );
  const factoryScreenAvailable =
    factoryPlugin?.surfaces.some((screen) => screen.id === "overview") === true;
  const handleOpenFactory = useCallback(() => {
    if (!settingsTarget || !factoryScreenAvailable) return;
    router.navigate(
      buildPluginSurfaceRoute(
        settingsTarget.serverId,
        "factory",
        { kind: "surface", id: "overview" },
        { projectId: settingsTarget.projectId },
      ),
    );
  }, [settingsTarget, factoryScreenAvailable]);
  const handleOpenProjectSettings = useCallback(() => {
    if (!settingsTarget) return;
    router.navigate(buildProjectSettingsRoute(settingsTarget.serverId, settingsTarget.projectId));
  }, [settingsTarget]);
  const canOpenInNewWindow = getIsElectron() && projectPath.trim().length > 0;
  const compact = useIsCompactFormFactor();
  const touch = useVortonTouch();
  // Touch has no tooltip, so the reason also shows under the item there.
  const removeBlockedReason = removeProjectBlockedReason ?? null;
  const showRemoveHint = removeBlockedReason !== null && (compact || touch);
  const handleOpenInNewWindow = useCallback(() => {
    const trimmedPath = projectPath.trim();
    if (trimmedPath.length === 0) return;
    void getDesktopHost()
      ?.window?.openNew?.({ pendingOpenProjectPath: trimmedPath })
      ?.catch((error) => {
        console.warn("[sidebar] openNew failed", error);
        toast.error(t("sidebar.project.actions.openNewWindowFailed"));
      });
  }, [projectPath, t, toast]);
  const workspaceFolderScope = useMemo(() => projectFolderScope(projectViewKey), [projectViewKey]);
  const createWorkspaceFolder = useCreateSidebarFolderAction(workspaceFolderScope, null);
  const moveToFolder = useMoveToSidebarFolderAction({
    scope: ROOT_FOLDER_SCOPE,
    entry: projectViewKey,
    title: projectName,
  });

  return (
    <>
      {factoryScreenAvailable ? (
        <>
          <ProjectMenuItem
            surface={surface}
            testID={`sidebar-project-menu-open-factory-${projectViewKey}`}
            onSelect={handleOpenFactory}
          >
            {t("projectFactory.open")}
          </ProjectMenuItem>
          <FactoryProjectActions
            surface={surface}
            settingsTarget={settingsTarget}
            projectPath={projectPath}
          />
        </>
      ) : null}
      {settingsTarget ? (
        <ProjectMenuItem
          surface={surface}
          testID={`sidebar-project-menu-open-settings-${projectViewKey}`}
          leading={settingsLeadingIcon}
          onSelect={handleOpenProjectSettings}
        >
          {t("sidebar.project.actions.openSettings")}
        </ProjectMenuItem>
      ) : null}
      {canOpenInNewWindow ? (
        <ProjectMenuItem
          surface={surface}
          testID={`sidebar-project-menu-open-new-window-${projectViewKey}`}
          leading={openInNewWindowLeadingIcon}
          onSelect={handleOpenInNewWindow}
        >
          {t("sidebar.project.actions.openNewWindow")}
        </ProjectMenuItem>
      ) : null}
      <OpenInFileManagerMenuItem
        surface={surface}
        path={projectPath}
        testID={`sidebar-project-menu-open-folder-${projectViewKey}`}
      />
      {createWorkspaceFolder ? (
        <ProjectMenuItem
          surface={surface}
          testID={`sidebar-project-menu-new-folder-${projectViewKey}`}
          leading={newFolderLeadingIcon}
          onSelect={createWorkspaceFolder}
        >
          {t("sidebar.folders.actions.newWorkspaceFolder")}
        </ProjectMenuItem>
      ) : null}
      {moveToFolder ? (
        <ProjectMenuItem
          surface={surface}
          testID={`sidebar-project-menu-move-folder-${projectViewKey}`}
          leading={moveToFolderLeadingIcon}
          onSelect={moveToFolder}
        >
          {t("sidebar.folders.actions.moveToFolder")}
        </ProjectMenuItem>
      ) : null}
      <ProjectMenuItem
        surface={surface}
        testID={`sidebar-project-menu-remove-${projectViewKey}`}
        leading={removeBlockedReason === null ? trash2LeadingIcon : lockedLeadingIcon}
        disabled={removeBlockedReason !== null}
        description={showRemoveHint ? (removeBlockedReason ?? undefined) : undefined}
        tooltip={removeBlockedReason ?? undefined}
        status={removeProjectStatus}
        pendingLabel={t("sidebar.project.actions.removing")}
        onSelect={removeBlockedReason === null ? onRemoveProject : undefined}
      >
        {t("sidebar.project.actions.remove")}
      </ProjectMenuItem>
    </>
  );
}

function WorkspaceRowRightGroup({
  workspace,
  backdrop,
  isTouchPlatform,
  isCreating,
  showShortcutBadge,
  shortcutNumber,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  onArchive,
  onMarkAsRead,
  onMarkAsUnread,
  onCopyBranchName,
  onCopyPath,
  onRename,
  isPinned,
  onTogglePin,
  showPinMarker,
}: {
  workspace: SidebarWorkspaceEntry;
  backdrop: SidebarSurfaceBackdrop;
  isTouchPlatform: boolean;
  isCreating: boolean;
  showShortcutBadge: boolean;
  shortcutNumber: number | null;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  onArchive?: () => void;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  showPinMarker: boolean;
}) {
  const sessionMenu = useWorkspaceSessionMenu(workspace.serverId, workspace.workspaceId);
  const workspacePath = workspace.workspaceDirectory ?? workspace.projectRootPath;
  const { t } = useTranslation();
  const trailing = useSidebarWorkspaceTrailing();
  const showShortcut = showShortcutBadge && shortcutNumber !== null;
  const {
    trailingPresentation,
    showKebab: showKebabInSlot,
    renderSlot,
  } = resolveTrailingActionVisibility({
    workspace,
    trailing,
    hasArchiveAction: Boolean(onArchive),
    isTouchPlatform,
    showShortcut,
  });
  const kebab = useOpenKebabMenuVisibility(showKebabInSlot);
  const menuBackdrop = sidebarMenuBackdrop(backdrop, kebab.menuProps.open);

  return (
    <>
      {sessionMenu.sheet}
      {isCreating ? (
        <Text style={styles.workspaceCreatingText}>{t("sidebar.workspace.status.creating")}</Text>
      ) : null}
      {renderSlot ? (
        <SidebarWorkspaceTrailingActionSlot>
          <SidebarWorkspaceTrailingActionBase presentation={trailingPresentation}>
            <SidebarWorkspaceTrailingContent workspace={workspace} trailing={trailing} />
          </SidebarWorkspaceTrailingActionBase>
          <SidebarWorkspaceTrailingDetails workspace={workspace} showPinMarker={showPinMarker} />
          <SidebarWorkspaceMenuReveal
            visible={kebab.showKebab}
            pinned={kebab.menuProps.open}
            backdrop={menuBackdrop}
          >
            {onArchive ? (
              <SidebarWorkspaceMenu
                {...sessionMenu}
                {...kebab.menuProps}
                backdrop={menuBackdrop}
                workspaceKey={workspace.workspaceKey}
                projectViewKey={workspace.projectViewKey}
                workspaceTitle={workspace.name}
                serverId={workspace.serverId}
                workspaceId={workspace.workspaceId}
                workspaceLabels={workspace.labels}
                onCopyPath={onCopyPath}
                onCopyBranchName={onCopyBranchName}
                onRename={onRename}
                onMarkAsRead={onMarkAsRead}
                onMarkAsUnread={onMarkAsUnread}
                onArchive={onArchive}
                archiveLabel={archiveLabel}
                archiveStatus={archiveStatus}
                archivePendingLabel={archivePendingLabel}
                archiveShortcutKeys={archiveShortcutKeys}
                isPinned={isPinned}
                onTogglePin={onTogglePin}
                openInFileManagerPath={workspacePath}
              />
            ) : null}
          </SidebarWorkspaceMenuReveal>
        </SidebarWorkspaceTrailingActionSlot>
      ) : null}
    </>
  );
}

function NewWorktreeButton({
  displayName,
  onPress,
  revealOnHover = false,
  loading = false,
  testID,
  showShortcutHint = false,
}: {
  displayName: string;
  onPress: () => void;
  /** Hidden until its project row is hovered or focused, by CSS. */
  revealOnHover?: boolean;
  loading?: boolean;
  testID: string;
  showShortcutHint?: boolean;
}) {
  const { t } = useTranslation();
  const newWorktreeKeys = useShortcutKeys("new-worktree");
  const actionSize = useSidebarActionSize();

  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.projectIconActionButton,
      actionSize,
      !loading && styles.projectIconActionButtonHoverable,
      pressed && !loading && styles.projectIconActionButtonPressed,
    ],
    [loading, actionSize],
  );

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  return (
    <View
      dataSet={VORTON_ACTION_SLOT}
      style={[
        styles.projectTrailingControlSlot,
        actionSize,
        revealOnHover && styles.projectActionReveal,
      ]}
    >
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <Pressable
            style={pressableStyle}
            onPress={handlePress}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={t("sidebar.workspace.actions.createWorkspaceFor", {
              projectName: displayName,
            })}
            testID={testID}
          >
            {({ pressed }) =>
              loading ? (
                <ThemedLoadingSpinner size={14} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedPlus
                  size={15}
                  uniProps={!isWeb && pressed ? foregroundColorMapping : currentColorMapping}
                />
              )
            }
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.projectActionTooltipRow}>
            <Text style={styles.projectActionTooltipText}>
              {t("sidebar.workspace.actions.newWorkspace")}
            </Text>
            {showShortcutHint && newWorktreeKeys ? (
              <Shortcut chord={newWorktreeKeys} style={styles.projectActionTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const ghostRowPlusIconProps = densityIconProps("sm", currentColorMapping);
const ghostRowPlusIconPressedProps = densityIconProps("sm", foregroundColorMapping);

function NewWorkspaceGhostRow({
  project,
  displayName,
  worktreeTarget,
  onWorkspacePress,
}: {
  project: SidebarProjectEntry;
  displayName: string;
  worktreeTarget: SidebarProjectHostTarget;
  onWorkspacePress?: () => void;
}) {
  const density = useSidebarRowDensity();
  const { t } = useTranslation();
  const handlePress = useSidebarNewWorkspaceRoute({
    project,
    displayName,
    target: worktreeTarget,
    onBeforeNavigate: onWorkspacePress,
  });
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.newWorkspaceGhostRow,
      density,
      sidebarWorkspaceRowStyles.projectIndented,
      !pressed && styles.newWorkspaceGhostRowHoverable,
      pressed && styles.newWorkspaceGhostRowPressed,
    ],
    [density],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("sidebar.workspace.actions.createWorkspaceFor", {
        projectName: displayName,
      })}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-project-new-workspace-row-${project.viewKey}`}
    >
      {({ pressed }) => (
        <>
          <View
            style={[
              styles.newWorkspaceGhostIconSlot,
              pressed && styles.newWorkspaceGhostIconSlotPressed,
            ]}
          >
            <ThemedPlus
              uniProps={!isWeb && pressed ? ghostRowPlusIconPressedProps : ghostRowPlusIconProps}
            />
          </View>
          <Text
            style={[styles.newWorkspaceGhostText, pressed && styles.newWorkspaceGhostTextPressed]}
            numberOfLines={1}
          >
            {t("sidebar.workspace.actions.newWorkspace")}
          </Text>
        </>
      )}
    </Pressable>
  );
}

function ProjectTaskSummaryView({
  summary,
  projectViewKey,
}: {
  summary: ProjectTaskSummary;
  projectViewKey: string;
}) {
  if (summary.count === 0 && summary.additions === 0 && summary.deletions === 0) return null;
  return (
    <View style={styles.projectTaskSummary} testID={`sidebar-project-summary-${projectViewKey}`}>
      <DiffStat additions={summary.additions} deletions={summary.deletions} hideZero />
      {summary.count > 0 && (
        <SidebarCountBadge
          label={String(summary.count)}
          accessibilityLabel={`${summary.count} open tasks`}
        />
      )}
    </View>
  );
}

/** A folded project shows its task summary; the focus button joins it on hover. */
function ProjectCollapsedTrailing({
  summary,
  projectViewKey,
  displayName,
  focusAction,
}: {
  summary: ProjectTaskSummary;
  projectViewKey: string;
  displayName: string;
  focusAction: (() => void) | null;
}) {
  return (
    <>
      <ProjectTaskSummaryView summary={summary} projectViewKey={projectViewKey} />
      {focusAction ? (
        <SidebarFocusButton
          name={displayName}
          onPress={focusAction}
          testID={`sidebar-project-focus-${projectViewKey}`}
        />
      ) : null}
    </>
  );
}

/** A calm project row stays calm on hover; brightness is kept for things to review. */
function projectTitleStyle(calm: boolean) {
  return calm ? [styles.projectTitle, styles.calmTitle] : styles.projectTitle;
}

function projectTrailingStyle(calm: boolean) {
  return calm ? [styles.projectTrailingGroup, styles.calmTrailing] : styles.projectTrailingGroup;
}

function ProjectHeaderRow({
  taskSummary,
  project,
  displayName,
  iconDataUri,
  statusBucket,
  selected = false,
  chevron,
  onPress,
  worktreeTarget,
  isProjectActive = false,
  onWorkspacePress,
  onWorktreeCreated: _onWorktreeCreated,
  shortcutNumber = null,
  showShortcutBadge = false,
  drag,
  isDragging,
  isArchiving = false,
  menuController,
  onRemoveProject,
  removeProjectStatus = "idle",
  removeProjectBlockedReason,
  dragHandleProps,
}: ProjectHeaderRowProps) {
  const density = useSidebarRowDensity();
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const touch = useVortonTouch();
  const isMobileBreakpoint = useIsCompactFormFactor();
  const localDaemonServerId = useLocalDaemonServerId();
  const projectPath = resolveSidebarProjectLocalPath(project, localDaemonServerId);
  const settingsTarget = project.hosts[0] ?? null;
  const handleBeginWorkspaceSetup = useSidebarNewWorkspaceRoute({
    project,
    displayName,
    target: worktreeTarget,
    onBeforeNavigate: onWorkspacePress,
  });
  const interaction = useLongPressDragInteraction({
    drag,
    menuController,
  });
  const focusTarget = useMemo<SidebarFocusTarget>(
    () => ({ kind: "project", projectKey: project.viewKey }),
    [project.viewKey],
  );
  const rowFocus = useSidebarRowFocus({ target: focusTarget, isHovered });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onPress();
  }, [interaction.didLongPressRef, onPress]);

  const handlePointerEnter = useCallback(() => {
    if (!contextMenuOpen && !touch) setIsHovered(true);
  }, [contextMenuOpen, touch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
  const handleProjectPressIn = useCallback(
    (event: GestureResponderEvent) => {
      setIsPressed(true);
      interaction.handlePressIn(event);
    },
    [interaction],
  );
  const handleProjectPressOut = useCallback(() => {
    setIsPressed(false);
    interaction.handlePressOut();
  }, [interaction]);

  // The row's fill, calm look, leading arrow and badge cutout follow CSS hover, so they settle
  // when the list moves under a resting cursor. JS hover only mounts the focus button. Touch
  // layouts and an open context menu never showed hover.
  const hoverable = !touch && !contextMenuOpen;
  const projectRowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.projectRow,
      styles.projectRowGroup,
      density,
      // CSS hover wins over the selected and dragging fills whatever the order, so the hover
      // entry goes first: the dragging and selected entries then override the resting surface it
      // publishes. The pressed fill wins over hover by leaving it out.
      hoverable && !pressed && styles.projectRowHoverable,
      isDragging && styles.projectRowDragging,
      selected && styles.sidebarRowSelected,
      pressed && styles.projectRowPressed,
    ],
    [isDragging, selected, hoverable, density],
  );

  const calm = isSidebarRowCalm({ selected, hovered: false, bucket: statusBucket });
  const rowChildren = (
    <View style={styles.projectRowLeft}>
      <ProjectLeadingVisual
        displayName={displayName}
        iconDataUri={iconDataUri}
        statusBucket={statusBucket}
        projectViewKey={project.viewKey}
        backdrop={getSidebarRowBackdrop({ isDragging, isPressed, selected })}
        chevron={chevron}
        cssHover={!touch}
        isArchiving={isArchiving}
      />

      <View style={styles.projectTitleGroup}>
        <Text style={projectTitleStyle(calm)} numberOfLines={1}>
          {displayName}
        </Text>
      </View>
    </View>
  );

  // Actions are siblings of the project button so each has its own accessible target.
  const trailingContent = (
    <>
      <View style={projectTrailingStyle(calm)}>
        {taskSummary ? (
          <ProjectCollapsedTrailing
            summary={taskSummary}
            projectViewKey={project.viewKey}
            displayName={displayName}
            focusAction={rowFocus.hoverAction}
          />
        ) : (
          <ProjectRowTrailingActions
            projectViewKey={project.viewKey}
            displayName={displayName}
            worktreeTarget={worktreeTarget}
            settingsTarget={settingsTarget}
            projectPath={projectPath}
            isMobileBreakpoint={isMobileBreakpoint}
            isProjectActive={isProjectActive}
            expanded={chevron === "collapse"}
            onBeginWorkspaceSetup={handleBeginWorkspaceSetup}
            onRemoveProject={onRemoveProject}
            removeProjectStatus={removeProjectStatus}
            removeProjectBlockedReason={removeProjectBlockedReason}
            focus={rowFocus}
          />
        )}
      </View>
      {showShortcutBadge && shortcutNumber !== null ? (
        <View style={styles.projectShortcutBadgeOverlay} pointerEvents="none">
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        </View>
      ) : null}
    </>
  );

  if (!onRemoveProject) {
    return (
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        style={projectRowStyle({ pressed: isPressed })}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <PressHighlight
          accessibilityRole="button"
          style={styles.projectRowMain}
          accessibilityLabel={displayName}
          highlightStyle={styles.projectRowPressed}
          onPressIn={handleProjectPressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={handleProjectPressOut}
          onPress={handlePress}
          testID={`sidebar-project-row-${project.viewKey}`}
        >
          {rowChildren}
        </PressHighlight>
        {trailingContent}
      </View>
    );
  }

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpenChange}>
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        style={projectRowStyle({ pressed: isPressed })}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <ContextMenuTrigger
          enabledOnMobile={false}
          accessibilityRole="button"
          style={styles.projectRowMain}
          accessibilityLabel={displayName}
          highlightStyle={styles.projectRowPressed}
          onPressIn={handleProjectPressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={handleProjectPressOut}
          onPress={handlePress}
          testID={`sidebar-project-row-${project.viewKey}`}
        >
          {rowChildren}
        </ContextMenuTrigger>
        {trailingContent}
      </View>
      <ContextMenuContent
        align="start"
        width={220}
        testID={`sidebar-project-context-menu-${project.viewKey}`}
      >
        <ProjectMenuItems
          surface="context"
          projectViewKey={project.viewKey}
          projectName={displayName}
          settingsTarget={settingsTarget}
          projectPath={projectPath}
          onRemoveProject={onRemoveProject}
          removeProjectStatus={removeProjectStatus}
          removeProjectBlockedReason={removeProjectBlockedReason}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WorkspaceRowInner({
  workspace,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  isArchiving,
  isCreating = false,
  dragHandleProps,
  menuController,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onCopyBranchName,
  onCopyPath,
  onRename,
  onMarkAsRead,
  onMarkAsUnread,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  reserveIdleStatusIndicatorSpace = true,
  indentLevel = 1,
}: WorkspaceRowInnerProps) {
  const density = useSidebarRowDensity();
  const isCompact = useIsCompactFormFactor();
  const [isPressed, setIsPressed] = useState(false);
  const vortonTouch = useVortonTouch();
  const isTouchPlatform = platformIsNative || isCompact || vortonTouch;
  const interaction = useLongPressDragInteraction({
    drag,
    menuController,
  });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    if (isDragging) return;
    onPress();
  }, [interaction.didLongPressRef, onPress, isDragging]);
  const handleWorkspacePressIn = useCallback(
    (event: GestureResponderEvent) => {
      setIsPressed(true);
      interaction.handlePressIn(event);
    },
    [interaction],
  );
  const handleWorkspacePressOut = useCallback(() => {
    setIsPressed(false);
    interaction.handlePressOut();
  }, [interaction]);

  const accessibilityState = useMemo(() => ({ selected }), [selected]);

  return (
    <SidebarWorkspaceRowFrame workspace={workspace} isDragging={isDragging}>
      {({ contextMenuOpen, onContextMenuOpenChange }) => {
        const isDesktop = !isTouchPlatform;
        const serviceSummary = isDesktop ? selectWorkspaceServiceSummary(workspace.scripts) : null;
        const workspaceRowStyle = getProjectWorkspaceRowStyle({
          isDragging,
          isPressed,
          selected,
          hoverable: !isTouchPlatform && !contextMenuOpen,
        });
        const backdrop = getSidebarRowBackdrop({ isDragging, isPressed, selected });
        return (
          <View
            {...dragAttributes}
            {...dragHandleProps?.listeners}
            ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
            style={styles.workspaceRowContainer}
          >
            <SidebarWorkspaceContextMenu
              contextMenuOpen={contextMenuOpen}
              onContextMenuOpenChange={onContextMenuOpenChange}
              workspace={workspace}
              leadingProjectName={leadingProjectName}
              hostBadgeLabel={hostBadge?.label}
              workspaceKey={workspace.workspaceKey}
              onCopyPath={onCopyPath}
              onCopyBranchName={onCopyBranchName}
              onRename={onRename}
              onMarkAsRead={onMarkAsRead}
              onMarkAsUnread={onMarkAsUnread}
              onArchive={onArchive}
              archiveLabel={archiveLabel}
              archiveStatus={archiveStatus}
              archivePendingLabel={archivePendingLabel}
              archiveShortcutKeys={archiveShortcutKeys}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              openInFileManagerPath={workspace.workspaceDirectory}
              disabled={isArchiving}
              aria-selected={selected}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={[workspaceRowStyle, density, sidebarIndentStyle(indentLevel)]}
              highlightStyle={styles.workspaceRowPressed}
              onPressIn={handleWorkspacePressIn}
              onTouchMove={interaction.handleTouchMove}
              onPressOut={handleWorkspacePressOut}
              onPress={handlePress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                hostBadge={hostBadge}
                leadingProjectName={leadingProjectName}
                leadingProjectIconDataUri={leadingProjectIconDataUri}
                serviceSummary={serviceSummary}
                backdrop={backdrop}
                selected={selected}
                isLoading={isArchiving || isCreating}
                isCreating={isCreating}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
                reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
              >
                <WorkspaceRowRightGroup
                  workspace={workspace}
                  // Only rows under Pinned lead with their project, so this is the home row.
                  showPinMarker={Boolean(isPinned) && !leadingProjectName}
                  backdrop={backdrop}
                  isTouchPlatform={isTouchPlatform}
                  isCreating={isCreating}
                  showShortcutBadge={showShortcutBadge}
                  shortcutNumber={shortcutNumber}
                  archiveLabel={archiveLabel}
                  archiveStatus={archiveStatus}
                  archivePendingLabel={archivePendingLabel}
                  archiveShortcutKeys={archiveShortcutKeys}
                  onArchive={onArchive}
                  onCopyBranchName={onCopyBranchName}
                  onCopyPath={onCopyPath}
                  onRename={onRename}
                  onMarkAsRead={onMarkAsRead}
                  onMarkAsUnread={onMarkAsUnread}
                  isPinned={isPinned}
                  onTogglePin={onTogglePin}
                />
              </SidebarWorkspaceRowContent>
            </SidebarWorkspaceContextMenu>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function WorkspaceRowWithMenu({
  workspace,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  canCopyBranchName,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  isCreating = false,
  indentLevel,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  indentLevel?: number;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  canCopyBranchName: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  isCreating?: boolean;
}) {
  const { t } = useTranslation();
  const {
    isArchiving,
    archiveProtected,
    isRenameOpen,
    handleArchive,
    handleCopyPath,
    handleCopyBranchName,
    handleOpenRename,
    handleCloseRename,
    isPinned,
    onTogglePin,
    archiveShortcutKeys,
    hasClearableAttention,
    canMarkUnread,
    handleMarkAsRead,
    handleMarkAsUnread,
  } = useWorkspaceMenuActions({
    workspace,
    selected,
    canPin,
    onToggleWorkspacePin,
  });

  useKeyboardActionHandler({
    handlerId: `workspace-archive-${workspace.workspaceKey}`,
    actions: ["workspace.archive"],
    enabled: selected && !isArchiving && !archiveProtected,
    priority: 0,
    handle: () => {
      handleArchive();
      return true;
    },
  });

  return (
    <>
      <WorkspaceRowInner
        workspace={workspace}
        hostBadge={hostBadge}
        leadingProjectName={leadingProjectName}
        leadingProjectIconDataUri={leadingProjectIconDataUri}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        onPress={onPress}
        drag={drag}
        isDragging={isDragging}
        isArchiving={isArchiving}
        isCreating={isCreating}
        dragHandleProps={dragHandleProps}
        menuController={null}
        archiveLabel={t("sidebar.workspace.actions.archive")}
        archiveStatus={isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        onArchive={handleArchive}
        onCopyBranchName={canCopyBranchName ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onRename={handleOpenRename}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        onMarkAsUnread={canMarkUnread ? handleMarkAsUnread : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
        reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
        indentLevel={indentLevel}
      />
      <WorkspaceRenameModal
        visible={isRenameOpen}
        workspace={workspace}
        onClose={handleCloseRename}
        testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
      />
    </>
  );
}

interface WorkspaceRowItemProps {
  workspace: SidebarWorkspacePlacement;
  workspaceEntry: SidebarWorkspaceEntry | null;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canCopyBranchName: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  isCreating?: boolean;
  indentLevel?: number;
  selectionEnabled: boolean;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  onWorkspacePress?: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

function WorkspaceRowItem({
  workspace,
  workspaceEntry,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  shortcutNumber,
  showShortcutBadge,
  canCopyBranchName,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  isCreating = false,
  indentLevel,
  selectionEnabled,
  activeWorkspaceSelection,
  onWorkspacePress,
  drag,
  isDragging = false,
  dragHandleProps,
}: WorkspaceRowItemProps) {
  const handlePress = useCallback(() => {
    if (!workspace.serverId) {
      return;
    }
    // Lets a host surface such as the rail flyout close before the route changes.
    onWorkspacePress?.();
    navigateToWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
    });
  }, [onWorkspacePress, workspace.serverId, workspace.workspaceId]);

  return (
    <WorkspaceRow
      workspaceEntry={workspaceEntry}
      hostBadge={hostBadge}
      leadingProjectName={leadingProjectName}
      leadingProjectIconDataUri={leadingProjectIconDataUri}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canCopyBranchName={canCopyBranchName}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      isCreating={isCreating}
      indentLevel={indentLevel}
      selected={isWorkspaceSelected({
        selection: activeWorkspaceSelection,
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
        enabled: selectionEnabled,
      })}
      onPress={handlePress}
      drag={drag}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
    />
  );
}

function areWorkspaceRowItemPropsEqual(
  previous: WorkspaceRowItemProps,
  next: WorkspaceRowItemProps,
): boolean {
  const previousSelected = isWorkspaceSelected({
    selection: previous.activeWorkspaceSelection,
    serverId: previous.workspace.serverId,
    workspaceId: previous.workspace.workspaceId,
    enabled: previous.selectionEnabled,
  });
  const nextSelected = isWorkspaceSelected({
    selection: next.activeWorkspaceSelection,
    serverId: next.workspace.serverId,
    workspaceId: next.workspace.workspaceId,
    enabled: next.selectionEnabled,
  });
  return (
    previous.workspace === next.workspace &&
    previous.workspaceEntry === next.workspaceEntry &&
    previous.hostBadge === next.hostBadge &&
    previous.leadingProjectName === next.leadingProjectName &&
    previous.leadingProjectIconDataUri === next.leadingProjectIconDataUri &&
    (!next.showShortcutBadge || previous.shortcutNumber === next.shortcutNumber) &&
    previous.showShortcutBadge === next.showShortcutBadge &&
    previous.canCopyBranchName === next.canCopyBranchName &&
    previous.canPin === next.canPin &&
    previous.onToggleWorkspacePin === next.onToggleWorkspacePin &&
    previous.reserveIdleStatusIndicatorSpace === next.reserveIdleStatusIndicatorSpace &&
    previous.isCreating === next.isCreating &&
    previous.indentLevel === next.indentLevel &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previousSelected === nextSelected
  );
}

const MemoWorkspaceRowItem = memo(WorkspaceRowItem, areWorkspaceRowItemPropsEqual);

function WorkspaceRow({
  workspaceEntry,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  canCopyBranchName,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  isCreating = false,
  indentLevel,
  selected,
}: {
  workspaceEntry: SidebarWorkspaceEntry | null;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  canCopyBranchName: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  isCreating?: boolean;
  indentLevel?: number;
  selected: boolean;
}) {
  if (!workspaceEntry) {
    return null;
  }

  return (
    <WorkspaceRowWithMenu
      workspace={workspaceEntry}
      hostBadge={hostBadge}
      leadingProjectName={leadingProjectName}
      leadingProjectIconDataUri={leadingProjectIconDataUri}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      onPress={onPress}
      drag={drag}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
      canCopyBranchName={canCopyBranchName}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      isCreating={isCreating}
      indentLevel={indentLevel}
    />
  );
}

/** Standing or Factory workspaces, which reorder only within their section. */
function SectionWorkspaceList({
  projectKey,
  section,
  items,
  level,
  externalDrop,
  renderItem,
  onReorder,
  extraData,
  nestable,
  parentGestureRef,
  dragGestureHostActive,
}: {
  projectKey: string;
  section: SidebarFocusSection;
  items: SidebarWorkspacePlacement[];
  /** Hierarchy level of the section's workspaces. */
  level: number;
  externalDrop: ComponentProps<typeof DraggableList<SidebarWorkspacePlacement>>["externalDrop"];
  renderItem: (info: DraggableRenderItemInfo<SidebarWorkspacePlacement>) => ReactElement;
  onReorder: (workspaces: SidebarWorkspacePlacement[]) => void;
  extraData: string;
  nestable: boolean;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
}) {
  const describe = useMemo(
    () => sectionWorkspaceDescriber(projectKey, section),
    [projectKey, section],
  );
  const top = useMemo(() => sectionDropTop(projectKey, section), [projectKey, section]);
  const handleDrop = useCallback(
    (dragged: SidebarDropRow, placement: SidebarDropPlacement) => {
      const keys = reorderKeys(items.map(workspaceKeyExtractor), dragged.key, placement);
      const byKey = new Map(items.map((item) => [item.workspaceKey, item]));
      onReorder(keys.flatMap((key) => byKey.get(key) ?? []));
    },
    [items, onReorder],
  );
  const treeDrop = useSidebarTreeDrop({
    items,
    describe,
    top,
    baseLevel: level,
    outside: "cancel",
    onDrop: handleDrop,
  });
  return (
    <DraggableList
      externalDrop={externalDrop}
      treeDrop={isWeb ? treeDrop : undefined}
      testID={`sidebar-${section}-list-${projectKey}`}
      data={items}
      keyExtractor={workspaceKeyExtractor}
      renderItem={renderItem}
      onDragEnd={onReorder}
      extraData={extraData}
      scrollEnabled={false}
      useDragHandle
      nestable={nestable}
      simultaneousGestureRef={parentGestureRef}
      gestureHostPresented={dragGestureHostActive}
      containerStyle={styles.workspaceListContainer}
    />
  );
}

/** A project's Standing or Factory section: its folder-like heading and its workspaces. */
function ProjectSection({
  projectKey,
  section,
  title,
  items,
  focus,
  level,
  itemLevel,
  beforeList,
  summary,
  renderList,
}: {
  projectKey: string;
  section: SidebarFocusSection;
  title: string;
  items: SidebarWorkspacePlacement[];
  focus: SidebarProjectBlockFocus | null;
  /** Level of the heading; null while this section is focused, which hides it. */
  level: number | null;
  /** Level of the section's workspaces. */
  itemLevel: number;
  beforeList?: ReactNode;
  summary?: ReactNode;
  renderList: (items: SidebarWorkspacePlacement[]) => ReactElement;
}) {
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  const groupKey = `${section}:${projectKey}`;
  const storedCollapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedWorkspaceGroupKeys.has(groupKey),
  );
  const toggleGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceGroupCollapsed,
  );
  const toggle = useCallback(
    () => toggleGroupCollapsed(groupKey),
    [toggleGroupCollapsed, groupKey],
  );
  const group = useLimitedSidebarTreeGroup(items);
  const target = useMemo<SidebarFocusTarget>(
    () => ({ kind: "section", projectKey, section }),
    [projectKey, section],
  );
  const focusAction = useSidebarFocusAction(target);
  // Sections have no menu, so touch layouts keep the focus button visible.
  const hoverUnavailable = touch || compact || platformIsNative;
  const testID = `sidebar-${section}-section-${projectKey}`;
  const trailing = useCallback(
    (isHovered: boolean) =>
      focusAction && (isHovered || hoverUnavailable) ? (
        <SidebarFocusButton name={title} onPress={focusAction} testID={`${testID}-focus`} />
      ) : null,
    [focusAction, hoverUnavailable, title, testID],
  );
  if ((items.length === 0 && !beforeList) || !isSidebarSectionShown(focus, section)) return null;
  // A focused section is the top level: its heading gives way to the breadcrumb and its
  // workspaces stay open.
  const collapsed = level !== null && storedCollapsed;
  return (
    <>
      {level === null ? null : (
        <SidebarSectionRow
          title={title}
          count={items.length}
          collapsed={collapsed}
          onToggle={toggle}
          level={level}
          testID={testID}
          trailing={trailing}
        />
      )}
      {summary}
      <SidebarDisclosureBody expanded={!collapsed}>
        {beforeList}
        {renderList(group.visibleItems)}
        {group.canToggle ? (
          <SidebarGroupToggleRow
            expanded={group.expanded}
            onPress={group.toggleExpanded}
            level={itemLevel}
            testID={`sidebar-${section}-show-more-${projectKey}`}
          />
        ) : null}
      </SidebarDisclosureBody>
    </>
  );
}

/** Removing a project from every host it is on, with its confirmation and failure toasts. */
function useProjectRemoval(project: SidebarProjectEntry, displayName: string) {
  const toast = useToast();
  const { t } = useTranslation();
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  // The daemon recreates and relies on the System project, so it stays in the sidebar.
  const isSystemProject = useIsSystemProjectOnAnyHost(project.hosts);

  const handleRemoveProject = useCallback(() => {
    if (isRemovingProject) {
      return;
    }

    void (async () => {
      const confirmed = await confirmDialog({
        title: t("sidebar.project.confirmations.removeTitle"),
        message: t("sidebar.project.confirmations.removeMessage", {
          projectName: displayName,
        }),
        confirmLabel: t("sidebar.project.confirmations.removeConfirm"),
        cancelLabel: t("sidebar.project.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      setIsRemovingProject(true);
      const readiness = getCurrentProjectRemoveReadiness({
        hosts: project.hosts,
      });
      if (readiness.kind === "needs_host_update") {
        toast.error(t("sidebar.project.toasts.updateHostToRemove"));
        setIsRemovingProject(false);
        return;
      }

      void removeProjectFromHosts({
        targets: readiness.targets,
        workspaces: project.workspaces,
        getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
      })
        .then((outcome) => {
          if (outcome.kind === "host_disconnected") {
            toast.error(t("sidebar.project.toasts.hostDisconnected"));
            return null;
          }
          if (outcome.kind === "failed") {
            toast.error(t("sidebar.project.toasts.removeFailed"));
          }
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("sidebar.project.toasts.removeFailed"),
          );
        })
        .finally(() => {
          setIsRemovingProject(false);
        });
    })();
  }, [isRemovingProject, displayName, t, toast, project.hosts, project.workspaces]);

  return { handleRemoveProject, isRemovingProject, isSystemProject };
}

/**
 * The focused project's own actions, which its hidden row would otherwise carry: new
 * workspace and the project menu. They sit on the breadcrumb's last segment.
 */
/**
 * Which of the focused item's actions to render. The breadcrumb keeps "create" (the new
 * workspace plus) always visible and reveals "menu" on hover where a pointer can hover.
 */
type FocusActionPart = "create" | "menu";

function ProjectFocusActions({
  project,
  supportsMultiplicityByServerId,
  onWorkspacePress,
  part,
}: {
  project: SidebarProjectEntry;
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>;
  onWorkspacePress?: () => void;
  part: FocusActionPart;
}) {
  const { t } = useTranslation();
  const displayName = project.projectName;
  const localDaemonServerId = useLocalDaemonServerId();
  const rowModel = useMemo(
    () =>
      buildSidebarProjectRowModel({
        project,
        collapsed: false,
        supportsMultiplicityByServerId,
      }),
    [project, supportsMultiplicityByServerId],
  );
  const worktreeTarget =
    rowModel.trailingAction.kind === "new_workspace" ? rowModel.trailingAction.target : null;
  const handleBeginWorkspaceSetup = useSidebarNewWorkspaceRoute({
    project,
    displayName,
    target: worktreeTarget,
    onBeforeNavigate: onWorkspacePress,
  });
  const { handleRemoveProject, isRemovingProject, isSystemProject } = useProjectRemoval(
    project,
    displayName,
  );
  if (part === "create") {
    return worktreeTarget ? (
      <View style={[styles.projectTrailingActions, styles.projectTrailingActionsVorton]}>
        <NewWorktreeButton
          displayName={displayName}
          onPress={handleBeginWorkspaceSetup}
          testID={`sidebar-focus-new-worktree-${project.viewKey}`}
        />
      </View>
    ) : null;
  }
  return (
    <View style={[styles.projectTrailingActions, styles.projectTrailingActionsVorton]}>
      <ProjectKebabMenu
        projectViewKey={project.viewKey}
        projectName={displayName}
        settingsTarget={project.hosts[0] ?? null}
        projectPath={resolveSidebarProjectLocalPath(project, localDaemonServerId)}
        onRemoveProject={handleRemoveProject}
        removeProjectStatus={isRemovingProject ? "pending" : "idle"}
        removeProjectBlockedReason={
          isSystemProject ? t("sidebar.project.actions.removeBlockedSystem") : null
        }
      />
    </View>
  );
}

/** Actions of the focused item, whose own row the focused view hides. */
function SidebarFocusActions({
  focus,
  world,
  projects,
  supportsMultiplicityByServerId,
  onWorkspacePress,
  part,
}: {
  focus: SidebarFocusTarget;
  world: SidebarFocusWorld;
  projects: readonly SidebarProjectEntry[];
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>;
  onWorkspacePress?: () => void;
  part: FocusActionPart;
}) {
  // Folders and sections have no create action; their menu stays hover-revealed.
  if (part === "create" && focus.kind !== "project") return null;
  if (focus.kind === "folder") {
    const folder = world.folders[focus.folderId];
    return folder ? <SidebarFolderMenuButton folder={folder} /> : null;
  }
  if (focus.kind === "section" || focus.kind === "pinned") return null;
  const project = projects.find((entry) => entry.viewKey === focus.projectKey);
  return project ? (
    <ProjectFocusActions
      project={project}
      supportsMultiplicityByServerId={supportsMultiplicityByServerId}
      onWorkspacePress={onWorkspacePress}
      part={part}
    />
  ) : null;
}

function ProjectBlock({
  project,
  workspaceEntriesByKey,
  collapsed,
  displayName,
  iconDataUri,
  selectionEnabled,
  showShortcutBadges,
  shortcutIndexByWorkspaceKey,
  parentGestureRef,
  onToggleCollapsed,
  onWorkspacePress,
  onWorkspaceReorder,
  onWorktreeCreated,
  manualSort,
  drag,
  isDragging,
  dragHandleProps,
  useNestable,
  dragGestureHostActive,
  creatingWorkspaceIds,
  activeWorkspaceSelection,
  hostBadgeByServerId,
  supportsMultiplicityByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  folderState,
  hideEmptyFolders,
  focus,
}: {
  project: SidebarProjectEntry;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  collapsed: boolean;
  displayName: string;
  iconDataUri: string | null;
  selectionEnabled: boolean;
  showShortcutBadges: boolean;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  onToggleCollapsed: (projectViewKey: string) => void;
  onWorkspacePress?: () => void;
  onWorkspaceReorder: (projectViewKey: string, workspaces: SidebarWorkspacePlacement[]) => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  manualSort: boolean;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  useNestable: boolean;
  dragGestureHostActive?: boolean;
  creatingWorkspaceIds: ReadonlySet<string>;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  /** Null when the sidebar host cannot store folders. */
  folderState: SidebarFolderState | null;
  hideEmptyFolders: boolean;
  focus: SidebarProjectBlockFocus | null;
}) {
  const externalDrop = useWorkspaceProjectDrop(project.viewKey);
  const folderScope = useMemo(() => projectFolderScope(project.viewKey), [project.viewKey]);
  const workExternalDrop = useMemo(() => treeRowExternalDrop(externalDrop), [externalDrop]);
  const taskSummary = useMemo(
    () => aggregateProjectTasks(project.viewKey, workspaceEntriesByKey),
    [project.viewKey, workspaceEntriesByKey],
  );
  const showTaskSummary = collapsed;
  const factoryHostIds = useMemo(
    () => Array.from(new Set(project.workspaces.map((workspace) => workspace.serverId))),
    [project.workspaces],
  );
  const supportsFactory = useHostFeatureMap(factoryHostIds, "factoryWorkspaceMembership");
  const factoryTargets = useMemo(
    () => projectFactoryTargets(project.hosts, project.workspaces, workspaceEntriesByKey),
    [project.hosts, project.workspaces, workspaceEntriesByKey],
  );
  const factoryStates = useProjectFactories(project.hosts, supportsFactory, factoryTargets);
  const groups = useMemo(
    () =>
      splitFactoryWorkspaces(
        project.workspaces,
        workspaceEntriesByKey,
        supportsFactory,
        factoryStates,
      ),
    [project.workspaces, workspaceEntriesByKey, supportsFactory, factoryStates],
  );
  // Folders organize ordinary workspaces only; Factory and Standing keep their own sections.
  const workRows = useMemo(() => {
    if (focus?.kind === "section") return [];
    const rows = buildSidebarTreeRows({
      state: folderState ?? EMPTY_SIDEBAR_FOLDER_STATE,
      scope: folderScope,
      items: groups.work,
      getKey: workspaceKeyExtractor,
      hideEmptyFolders,
      // Time-based sorts order the rows; folders still keep their saved places.
      itemOrder: manualSort ? "saved" : "given",
    });
    return focus?.kind === "folder"
      ? focusTreeRows(rows, sidebarFolderEntry(focus.folderId))
      : rows;
  }, [focus, folderState, folderScope, groups.work, hideEmptyFolders, manualSort]);
  // Focused contents become the top level, so their rows lose the project's step in.
  const { showHeader, childLevel, sectionLevel, sectionItemLevel } =
    sidebarProjectBlockLevels(focus);
  const installedPlugins = useInstalledPlugins();
  const pinnedFactoryKeys = useFactoryCardStore((state) => state.pinned);
  // Pinned Factory cards show under the root Pinned section instead, never twice. A focus hides
  // Pinned, so a pinned card stays in its project while one is active.
  const factoryCards = useMemo(
    () =>
      factoryCardModels({
        members: groups.factory,
        entries: workspaceEntriesByKey,
        states: factoryStates,
        plugins: installedPlugins,
      }).filter((card) => focus !== null || !pinnedFactoryKeys.includes(card.key)),
    [
      groups.factory,
      workspaceEntriesByKey,
      installedPlugins,
      factoryStates,
      pinnedFactoryKeys,
      focus,
    ],
  );

  // A missing entry renders no row, so it counts as done (createWorkspaceVisibilityPolicy).
  const isActiveWorkRow = useCallback(
    (item: SidebarWorkspacePlacement) =>
      (workspaceEntriesByKey.get(item.workspaceKey)?.statusBucket ?? "done") !== "done",
    [workspaceEntriesByKey],
  );
  const isOpenWorkRow = useCallback(
    (item: SidebarWorkspacePlacement) =>
      selectionEnabled &&
      activeWorkspaceSelection !== null &&
      item.serverId === activeWorkspaceSelection.serverId &&
      item.workspaceId === activeWorkspaceSelection.workspaceId,
    [activeWorkspaceSelection, selectionEnabled],
  );
  const workRowsPolicy = useMemo(
    () => ({ isActive: isActiveWorkRow, isOpen: isOpenWorkRow }),
    [isActiveWorkRow, isOpenWorkRow],
  );
  const {
    visibleItems: visibleWorkRows,
    leadingItem: leadingWorkspace,
    expanded: workspacesExpanded,
    canToggle: canToggleWorkspaces,
    toggleExpanded: toggleWorkspacesExpanded,
  } = useLimitedSidebarTreeRows(workRows, workRowsPolicy);
  const rowModel = useMemo(
    () =>
      buildSidebarProjectRowModel({
        project,
        collapsed,
        supportsMultiplicityByServerId,
      }),
    [collapsed, project, supportsMultiplicityByServerId],
  );

  // Collapsed rows hide their workspace rows, so the project row carries the most urgent
  // status among them; expanded rows leave the signal to the child rows themselves.
  const aggregateStatusBucket = useSidebarProjectStatusBucket({
    workspaces: project.workspaces,
    enabled: collapsed,
  });

  const active = isProjectSelectedByRoute({
    selection: activeWorkspaceSelection,
    project,
    enabled: selectionEnabled,
  });

  const renderWorkspaceRow = useCallback(
    (
      item: SidebarWorkspacePlacement,
      input?: {
        drag?: () => void;
        isDragging?: boolean;
        dragHandleProps?: DraggableListDragHandleProps;
        indentLevel?: number;
      },
    ) => {
      return (
        <MemoWorkspaceRowItem
          workspace={item}
          workspaceEntry={workspaceEntriesByKey.get(item.workspaceKey) ?? null}
          hostBadge={hostBadgeByServerId.get(item.serverId) ?? null}
          shortcutNumber={shortcutIndexByWorkspaceKey.get(item.workspaceKey) ?? null}
          showShortcutBadge={showShortcutBadges}
          canCopyBranchName={project.projectKind === "git"}
          canPin={supportsPinningByServerId.get(item.serverId) === true}
          onToggleWorkspacePin={onToggleWorkspacePin}
          isCreating={creatingWorkspaceIds.has(item.workspaceId)}
          selectionEnabled={selectionEnabled}
          activeWorkspaceSelection={activeWorkspaceSelection}
          onWorkspacePress={onWorkspacePress}
          drag={input?.drag}
          isDragging={input?.isDragging}
          dragHandleProps={input?.dragHandleProps}
          indentLevel={input?.indentLevel}
        />
      );
    },
    [
      project.projectKind,
      onToggleWorkspacePin,
      supportsPinningByServerId,
      activeWorkspaceSelection,
      creatingWorkspaceIds,
      hostBadgeByServerId,
      onWorkspacePress,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      workspaceEntriesByKey,
    ],
  );

  const renderWorkspace = useCallback(
    ({
      item,
      drag: workspaceDrag,
      isActive,
      dragHandleProps: workspaceDragHandleProps,
    }: DraggableRenderItemInfo<SidebarWorkspacePlacement>) => {
      return renderWorkspaceRow(item, {
        drag: workspaceDrag,
        isDragging: isActive,
        dragHandleProps: workspaceDragHandleProps,
        indentLevel: sectionItemLevel,
      });
    },
    [renderWorkspaceRow, sectionItemLevel],
  );

  const handleWorkspaceDragEnd = useCallback(
    (workspaces: SidebarWorkspacePlacement[]) => {
      onWorkspaceReorder(project.viewKey, workspaces);
    },
    [onWorkspaceReorder, project.viewKey],
  );
  const selectionKey = activeWorkspaceSelectionKey(activeWorkspaceSelection);
  const renderSectionList = useCallback(
    (section: SidebarFocusSection, items: SidebarWorkspacePlacement[]) => (
      <SectionWorkspaceList
        projectKey={project.viewKey}
        section={section}
        items={items}
        level={sectionItemLevel}
        externalDrop={externalDrop}
        renderItem={renderWorkspace}
        onReorder={handleWorkspaceDragEnd}
        extraData={selectionKey}
        nestable={useNestable}
        parentGestureRef={parentGestureRef}
        dragGestureHostActive={dragGestureHostActive}
      />
    ),
    [
      sectionItemLevel,
      externalDrop,
      project.viewKey,
      renderWorkspace,
      handleWorkspaceDragEnd,
      selectionKey,
      useNestable,
      parentGestureRef,
      dragGestureHostActive,
    ],
  );
  const renderStandingList = useCallback(
    (items: SidebarWorkspacePlacement[]) => renderSectionList("standing", items),
    [renderSectionList],
  );

  const renderWorkRow = useCallback(
    ({
      item: row,
      drag: rowDrag,
      isActive,
      dragHandleProps: rowDragHandleProps,
    }: DraggableRenderItemInfo<SidebarTreeRow<SidebarWorkspacePlacement>>) => {
      if (row.kind === "folder") {
        return (
          <SidebarFolderRow
            row={row}
            scope={folderScope}
            level={childLevel + row.depth}
            drag={rowDrag}
            isDragging={isActive}
            dragHandleProps={rowDragHandleProps}
          />
        );
      }
      return renderWorkspaceRow(row.item, {
        drag: rowDrag,
        isDragging: isActive,
        dragHandleProps: rowDragHandleProps,
        indentLevel: childLevel + row.depth,
      });
    },
    [childLevel, folderScope, renderWorkspaceRow],
  );

  const describeWorkRow = useMemo(() => workRowDescriber(project.viewKey), [project.viewKey]);
  // A focused project folder receives the drops at its contents' top level.
  const focusFolderId = focus?.kind === "folder" ? focus.folderId : null;
  const workDropTop = useMemo(
    () =>
      focusFolderId === null
        ? projectDropTop(project.viewKey)
        : projectFolderDropTop(project.viewKey, focusFolderId),
    [project.viewKey, focusFolderId],
  );
  const handleWorkDrop = useCallback(
    (dragged: SidebarDropRow, placement: SidebarDropPlacement) => {
      if (folderState) {
        const container = placement.container;
        const targetFolderId =
          container === null || container === project.viewKey ? null : folderIdOfEntry(container);
        const keys = groups.work.map(workspaceKeyExtractor);
        let { beforeKey, afterKey } = placement;
        if (!manualSort) {
          // The sort orders workspaces, so only folder membership and folder slots can change.
          const isFolder = folderIdOfEntry(dragged.key) !== null;
          const sourceFolderId = sidebarEntryParent({
            state: folderState,
            scope: folderScope,
            entry: dragged.key,
          });
          if (!isFolder && sourceFolderId === targetFolderId) return;
          const anchor = (key: string | null) =>
            savedSidebarAnchor({ state: folderState, scope: folderScope, keys, anchor: key });
          beforeKey = anchor(beforeKey);
          afterKey = anchor(afterKey);
        }
        placeSidebarEntry({
          scope: folderScope,
          entry: dragged.key,
          targetFolderId,
          before: beforeKey,
          after: afterKey,
          keys,
        });
        return;
      }
      const items = treeRowItems(visibleWorkRows);
      const keys = reorderKeys(items.map(workspaceKeyExtractor), dragged.key, placement);
      const byKey = new Map(items.map((item) => [item.workspaceKey, item]));
      onWorkspaceReorder(
        project.viewKey,
        keys.flatMap((key) => byKey.get(key) ?? []),
      );
    },
    [
      folderState,
      folderScope,
      manualSort,
      project.viewKey,
      groups.work,
      visibleWorkRows,
      onWorkspaceReorder,
    ],
  );
  const workTreeDrop = useSidebarTreeDrop({
    items: visibleWorkRows,
    describe: describeWorkRow,
    top: workDropTop,
    baseLevel: childLevel,
    outside: "cancel",
    onDrop: handleWorkDrop,
  });

  const handleWorkRowsDragEnd = useCallback(
    (rows: SidebarTreeRow<SidebarWorkspacePlacement>[], movedKey: string) => {
      if (!manualSort) return;
      if (folderState) reorderSidebarRows({ scope: folderScope, rows, movedKey });
      else onWorkspaceReorder(project.viewKey, treeRowItems(rows));
    },
    [folderScope, folderState, manualSort, onWorkspaceReorder, project.viewKey],
  );

  const { t } = useTranslation();
  const { handleRemoveProject, isRemovingProject, isSystemProject } = useProjectRemoval(
    project,
    displayName,
  );

  const handleToggleCollapsed = useCallback(() => {
    onToggleCollapsed(project.viewKey);
  }, [onToggleCollapsed, project.viewKey]);

  let projectChildren = null;
  {
    if (project.workspaces.length > 0) {
      projectChildren = (
        <>
          {leadingWorkspace
            ? renderWorkspaceRow(leadingWorkspace, { indentLevel: childLevel })
            : null}
          <DraggableList
            externalDrop={workExternalDrop}
            treeDrop={isWeb ? workTreeDrop : undefined}
            testID={`sidebar-workspace-list-${project.viewKey}`}
            data={visibleWorkRows}
            keyExtractor={treeRowKeyExtractor}
            renderItem={renderWorkRow}
            onDragEnd={handleWorkRowsDragEnd}
            extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
            scrollEnabled={false}
            useDragHandle
            nestable={useNestable}
            simultaneousGestureRef={parentGestureRef}
            gestureHostPresented={dragGestureHostActive}
            containerStyle={styles.workspaceListContainer}
          />
          {canToggleWorkspaces ? (
            <SidebarGroupToggleRow
              expanded={workspacesExpanded}
              onPress={toggleWorkspacesExpanded}
              level={childLevel}
              testID={`sidebar-project-show-more-${project.viewKey}`}
            />
          ) : null}
          {isSidebarSectionShown(focus, "factory")
            ? factoryCards.map((card) => (
                <FactorySection
                  key={card.key}
                  card={card}
                  entries={workspaceEntriesByKey}
                  projectName={null}
                  level={childLevel}
                  activeWorkspaceSelection={activeWorkspaceSelection}
                  selectionEnabled={selectionEnabled}
                  canPinWorkspace={supportsPinningByServerId.get(card.serverId) === true}
                  onToggleWorkspacePin={onToggleWorkspacePin}
                  onWorkspacePress={onWorkspacePress}
                />
              ))
            : null}
          <ProjectSection
            projectKey={project.viewKey}
            section="standing"
            title="Standing"
            items={groups.standing}
            focus={focus}
            level={sectionLevel}
            itemLevel={sectionItemLevel}
            renderList={renderStandingList}
          />
        </>
      );
    } else if (rowModel.trailingAction.kind === "new_workspace") {
      projectChildren = (
        <NewWorkspaceGhostRow
          project={project}
          displayName={displayName}
          worktreeTarget={rowModel.trailingAction.target}
          onWorkspacePress={onWorkspacePress}
        />
      );
    }
  }

  return (
    <View role="group" accessibilityLabel={displayName} style={undefined}>
      {showHeader ? (
        // Only the header takes workspaces from other projects, so rows between projects
        // never move a workspace by accident.
        <ProjectDropTarget projectKey={project.viewKey}>
          <ProjectHeaderRow
            taskSummary={showTaskSummary ? taskSummary : undefined}
            project={project}
            displayName={displayName}
            iconDataUri={iconDataUri}
            statusBucket={aggregateStatusBucket}
            selected={false}
            chevron={rowModel.chevron}
            onPress={handleToggleCollapsed}
            worktreeTarget={
              rowModel.trailingAction.kind === "new_workspace"
                ? rowModel.trailingAction.target
                : null
            }
            isProjectActive={active}
            onWorkspacePress={onWorkspacePress}
            onWorktreeCreated={onWorktreeCreated}
            drag={drag}
            isDragging={isDragging}
            isArchiving={isRemovingProject}
            menuController={null}
            onRemoveProject={handleRemoveProject}
            removeProjectStatus={isRemovingProject ? "pending" : "idle"}
            removeProjectBlockedReason={
              isSystemProject ? t("sidebar.project.actions.removeBlockedSystem") : null
            }
            dragHandleProps={dragHandleProps}
          />
        </ProjectDropTarget>
      ) : null}

      <SidebarDisclosureBody expanded={!collapsed}>{projectChildren}</SidebarDisclosureBody>
    </View>
  );
}

type ProjectBlockProps = Parameters<typeof ProjectBlock>[0];

// oxlint-disable-next-line complexity
function areProjectBlockPropsEqual(previous: ProjectBlockProps, next: ProjectBlockProps): boolean {
  return (
    previous.project === next.project &&
    projectWorkspaceEntriesEqual(previous, next) &&
    previous.collapsed === next.collapsed &&
    previous.displayName === next.displayName &&
    previous.iconDataUri === next.iconDataUri &&
    previous.selectionEnabled === next.selectionEnabled &&
    previous.showShortcutBadges === next.showShortcutBadges &&
    projectShortcutBadgesEqual(previous, next) &&
    previous.hostBadgeByServerId === next.hostBadgeByServerId &&
    previous.supportsMultiplicityByServerId === next.supportsMultiplicityByServerId &&
    previous.supportsPinningByServerId === next.supportsPinningByServerId &&
    previous.onToggleWorkspacePin === next.onToggleWorkspacePin &&
    previous.onToggleCollapsed === next.onToggleCollapsed &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.parentGestureRef === next.parentGestureRef &&
    previous.onWorkspaceReorder === next.onWorkspaceReorder &&
    previous.useNestable === next.useNestable &&
    previous.dragGestureHostActive === next.dragGestureHostActive &&
    previous.manualSort === next.manualSort &&
    previous.onWorktreeCreated === next.onWorktreeCreated &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previous.creatingWorkspaceIds === next.creatingWorkspaceIds &&
    previous.folderState === next.folderState &&
    previous.hideEmptyFolders === next.hideEmptyFolders &&
    previous.focus === next.focus &&
    previous.activeWorkspaceSelection?.serverId === next.activeWorkspaceSelection?.serverId &&
    areProjectBlockSelectionsEqual(previous, next)
  );
}

function projectShortcutBadgesEqual(previous: ProjectBlockProps, next: ProjectBlockProps): boolean {
  if (
    !next.showShortcutBadges ||
    previous.shortcutIndexByWorkspaceKey === next.shortcutIndexByWorkspaceKey
  )
    return true;
  return next.project.workspaces.every(
    ({ workspaceKey }) =>
      previous.shortcutIndexByWorkspaceKey.get(workspaceKey) ===
      next.shortcutIndexByWorkspaceKey.get(workspaceKey),
  );
}

function projectWorkspaceEntriesEqual(
  previous: ProjectBlockProps,
  next: ProjectBlockProps,
): boolean {
  if (previous.workspaceEntriesByKey === next.workspaceEntriesByKey) return true;
  return next.project.workspaces.every(
    ({ workspaceKey }) =>
      previous.workspaceEntriesByKey.get(workspaceKey) ===
      next.workspaceEntriesByKey.get(workspaceKey),
  );
}

function areProjectBlockSelectionsEqual(
  previous: ProjectBlockProps,
  next: ProjectBlockProps,
): boolean {
  const previousActive = isProjectSelectedByRoute({
    selection: previous.activeWorkspaceSelection,
    project: previous.project,
    enabled: previous.selectionEnabled,
  });
  const nextActive = isProjectSelectedByRoute({
    selection: next.activeWorkspaceSelection,
    project: next.project,
    enabled: next.selectionEnabled,
  });
  if (previousActive !== nextActive) {
    return false;
  }
  if (!previousActive) {
    return true;
  }
  return (
    activeWorkspaceSelectionKey(previous.activeWorkspaceSelection) ===
    activeWorkspaceSelectionKey(next.activeWorkspaceSelection)
  );
}

const MemoProjectBlock = memo(ProjectBlock, areProjectBlockPropsEqual);

export function SidebarWorkspaceList({
  onContentSizeChange,
  onScrolledChange,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  groupMode,
  isRefreshing: _isRefreshing = false,
  onRefresh: _onRefresh,
  onWorkspacePress,
  onAddProject,
  onImportSession,
  listFooterComponent,
  listTopComponent,
  listHeaderComponent,
  parentGestureRef,
  dragGestureHostActive,
  rootFolders = true,
  onFocusElsewhere,
}: SidebarWorkspaceListProps) {
  const pathname = usePathname();
  const hosts = useHosts();
  const rowItems = useSidebarRowItems();
  // Host badge visibility is a lattice, not three competing switches: this gate is the global
  // "off", `shouldShowSidebarHostLabels` is the automatic "there is only one host so it says
  // nothing", and each host's own `badgeDisplay` decides name vs icon vs hidden. Turning the
  // item off here removes the badge everywhere; leaving it on defers to the per-host setting.
  const hostBadgeByServerId = useHostBadges({
    enabled: rowItems.host && shouldShowSidebarHostLabels(projects),
  });
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportsMultiplicityByServerId = useHostFeatureMap(serverIds, "workspaceMultiplicity");
  const supportsPinningByServerId = useHostFeatureMap(serverIds, "workspacePinning");
  const onToggleWorkspacePin = useSidebarWorkspacePinController();
  const getPinnedWorkspaceOrder = useSidebarOrderStore((state) => state.getPinnedWorkspaceOrder);
  const setPinnedWorkspaceOrder = useSidebarOrderStore((state) => state.setPinnedWorkspaceOrder);
  const handlePinnedWorkspaceReorder = useCallback(
    (reorderedWorkspaces: SidebarWorkspacePlacement[]) => {
      const reorderedWorkspaceKeys = reorderedWorkspaces.map((workspace) => workspace.workspaceKey);
      const currentOrder = getPinnedWorkspaceOrder();
      if (
        !hasVisibleOrderChanged({
          currentOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        })
      ) {
        return;
      }

      setPinnedWorkspaceOrder(
        mergeWithRemainder({
          currentOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        }),
      );
    },
    [getPinnedWorkspaceOrder, setPinnedWorkspaceOrder],
  );
  // One fetch, one map, every mode — project mode paints icons on its headers and status mode
  // paints them on each row, all keyed by `projectViewKey`. The targets come from the projection
  // that produced the rows, so the question "what is on screen" is answered once.
  const projectIconByProjectViewKey = useProjectIcons({
    projects: projectIconTargets,
  });

  // A filter that matches nothing swaps the list's body and nothing above it. It used to replace
  // this whole subtree, which unmounted the header — and the header is where the display menu's
  // trigger lives, so filtering the last row away closed the menu you were filtering from.
  //
  // Background visibility can also hide the last project. Keep the header mounted
  // whenever a local filter empties an otherwise populated directory, so users can
  // reach the display menu to reveal their work again.
  const sidebarFilterEmpty = hasProjectsBeforeFilter && projects.length === 0;

  // Project mode is the one that keeps its project headers; every other grouping mode is a flat
  // list of grouped rows, so a new mode lands in the grouped branch rather than silently in this
  // one's `else`.
  const content =
    groupMode !== "project" ? (
      <SidebarGroupedModeList
        onScrolledChange={onScrolledChange}
        workspaceGroups={workspaceGroups}
        pinnedGroups={pinnedGroups}
        workspaceEntriesByKey={workspaceEntriesByKey}
        projectIconByProjectViewKey={projectIconByProjectViewKey}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        onWorkspacePress={onWorkspacePress}
        hostBadgeByServerId={hostBadgeByServerId}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onPinnedWorkspaceReorder={handlePinnedWorkspaceReorder}
        listTopComponent={listTopComponent}
        listHeaderComponent={listHeaderComponent}
        sidebarFilterEmpty={sidebarFilterEmpty}
        parentGestureRef={parentGestureRef}
        dragGestureHostActive={dragGestureHostActive}
      />
    ) : (
      <ProjectModeList
        onContentSizeChange={onContentSizeChange}
        onScrolledChange={onScrolledChange}
        projects={projects}
        pinnedGroups={pinnedGroups}
        workspaceEntriesByKey={workspaceEntriesByKey}
        projectIconByProjectViewKey={projectIconByProjectViewKey}
        collapsedProjectKeys={collapsedProjectKeys}
        onToggleProjectCollapsed={onToggleProjectCollapsed}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        onWorkspacePress={onWorkspacePress}
        onAddProject={onAddProject}
        onImportSession={onImportSession}
        listFooterComponent={listFooterComponent}
        listTopComponent={listTopComponent}
        listHeaderComponent={listHeaderComponent}
        sidebarFilterEmpty={sidebarFilterEmpty}
        hasActiveProjectFilter={hasActiveProjectFilter}
        parentGestureRef={parentGestureRef}
        dragGestureHostActive={dragGestureHostActive}
        pathname={pathname}
        hostBadgeByServerId={hostBadgeByServerId}
        supportsMultiplicityByServerId={supportsMultiplicityByServerId}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onPinnedWorkspaceReorder={handlePinnedWorkspaceReorder}
        rootFolders={rootFolders}
        onFocusElsewhere={onFocusElsewhere}
      />
    );

  return content;
}

/**
 * Every grouping mode except project: the rows are grouped by something that is not a project, so
 * each row carries its own project icon. Named for what it does rather than for the first mode
 * that needed it — `SidebarStatusModeWrapper` is what made a label-mode reader believe the data
 * above it was status-only.
 */
function SidebarGroupedModeList({
  onScrolledChange,
  workspaceGroups,
  pinnedGroups,
  workspaceEntriesByKey,
  projectIconByProjectViewKey,
  shortcutIndexByWorkspaceKey: _projectShortcutIndex,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  onPinnedWorkspaceReorder,
  listTopComponent,
  listHeaderComponent,
  sidebarFilterEmpty,
  parentGestureRef,
  dragGestureHostActive,
}: {
  onScrolledChange?: (scrolled: boolean) => void;
  workspaceGroups: SidebarWorkspaceGroup[];
  pinnedGroups: PinnedSidebarGroups;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onPinnedWorkspaceReorder: (workspaces: SidebarWorkspacePlacement[]) => void;
  listTopComponent?: ReactElement | null;
  listHeaderComponent?: ReactElement | null;
  sidebarFilterEmpty: boolean;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
}) {
  const showShortcutBadges = useShowShortcutBadges();
  const pinnedWorkspaces = useMemo(
    () =>
      pinnedGroups.pinnedChats.flatMap((workspace) => {
        const entry = workspaceEntriesByKey.get(workspace.workspaceKey);
        return entry ? [entry] : [];
      }),
    [pinnedGroups.pinnedChats, workspaceEntriesByKey],
  );

  return (
    <SidebarStatusWorkspaceList
      onScrolledChange={onScrolledChange}
      groups={workspaceGroups}
      pinnedWorkspaces={pinnedWorkspaces}
      projectIconByProjectViewKey={projectIconByProjectViewKey}
      shortcutIndexByWorkspaceKey={_projectShortcutIndex}
      showShortcutBadges={showShortcutBadges}
      onWorkspacePress={onWorkspacePress}
      hostBadgeByServerId={hostBadgeByServerId}
      supportsPinningByServerId={supportsPinningByServerId}
      onToggleWorkspacePin={onToggleWorkspacePin}
      onPinnedWorkspaceReorder={onPinnedWorkspaceReorder}
      listTopComponent={listTopComponent}
      listHeaderComponent={listHeaderComponent}
      sidebarFilterEmpty={sidebarFilterEmpty}
      parentGestureRef={parentGestureRef}
      dragGestureHostActive={dragGestureHostActive}
    />
  );
}

function ProjectModeList(props: Parameters<typeof ProjectModeListContent>[0]) {
  return (
    <ProjectMoveProvider projects={props.projects}>
      <ProjectModeListContent {...props} />
    </ProjectMoveProvider>
  );
}

/**
 * What project mode shows beyond the stored sidebar: the device-local focus and the folding a
 * drag applies to its own view.
 */
function useProjectModeView(input: {
  projects: SidebarProjectEntry[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  folderState: SidebarFolderState | null;
  hideEmptyFolders: boolean;
  rootFolders: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  onFocusElsewhere?: () => void;
  hasPinned: boolean;
}) {
  const {
    hasPinned,
    projects,
    workspaceEntriesByKey,
    folderState,
    hideEmptyFolders,
    rootFolders,
    collapsedProjectKeys,
    onFocusElsewhere,
  } = input;
  const focusHostIds = useMemo(
    () =>
      Array.from(
        new Set(projects.flatMap((project) => project.workspaces.map((entry) => entry.serverId))),
      ),
    [projects],
  );
  const supportsFactoryByServerId = useHostFeatureMap(focusHostIds, "factoryWorkspaceMembership");
  const factoryHosts = useMemo(() => projects.flatMap((project) => project.hosts), [projects]);
  const factoryPollingTargets = useMemo(
    () =>
      projects.flatMap((project) =>
        projectFactoryTargets(project.hosts, project.workspaces, workspaceEntriesByKey),
      ),
    [projects, workspaceEntriesByKey],
  );
  const factoryStates = useProjectFactories(
    factoryHosts,
    supportsFactoryByServerId,
    factoryPollingTargets,
  );
  const projectGroups = useMemo(
    () =>
      projects.map((project) => {
        const hostProjects = new Set(
          project.hosts.map((host) => JSON.stringify([host.serverId, host.projectId])),
        );
        const states = factoryStates.filter((state) =>
          hostProjects.has(JSON.stringify([state.serverId, state.projectId])),
        );
        const groups = splitFactoryWorkspaces(
          project.workspaces,
          workspaceEntriesByKey,
          supportsFactoryByServerId,
          states,
        );
        return { project, groups, states };
      }),
    [projects, workspaceEntriesByKey, supportsFactoryByServerId, factoryStates],
  );
  const installedPlugins = useInstalledPlugins();
  const pinnedFactoryKeys = useFactoryCardStore((state) => state.pinned);
  // In pin order, each naming its project because Pinned sits outside every project.
  const pinnedFactoryCards = useMemo(() => {
    const cards = projectGroups.flatMap(({ project, groups, states }) =>
      factoryCardModels({
        members: groups.factory,
        entries: workspaceEntriesByKey,
        states,
        plugins: installedPlugins,
      }).map((card) => ({ card, projectName: project.projectName })),
    );
    return pinnedFactoryKeys.flatMap((key) => cards.filter(({ card }) => card.key === key));
  }, [projectGroups, workspaceEntriesByKey, installedPlugins, pinnedFactoryKeys]);
  const focusWorld = useMemo(
    () =>
      buildSidebarFocusWorld({
        folderState: folderState ?? EMPTY_SIDEBAR_FOLDER_STATE,
        projects: projectGroups.map(({ project, groups }) => {
          const sections: SidebarFocusSection[] = [];
          if (groups.standing.length > 0) sections.push("standing");
          if (groups.factory.length > 0) sections.push("factory");
          return {
            key: project.viewKey,
            name: project.projectName,
            sections,
            workspaceKeys: project.workspaces.map(workspaceKeyExtractor),
          };
        }),
        hideEmptyFolders,
        hasPinned: hasPinned || pinnedFactoryCards.length > 0,
      }),
    [folderState, projectGroups, hideEmptyFolders, hasPinned, pinnedFactoryCards.length],
  );
  // The compact rail's single-project flyout has no room for a focused view: it never shows
  // focus itself, and its Focus buttons focus the sidebar instead.
  const focusController = useSidebarFocusController({
    world: focusWorld,
    enabled: rootFolders,
  });
  const focusElsewhere = useMemo(() => {
    if (rootFolders || !onFocusElsewhere) return null;
    return {
      focus: null,
      focusOn: (target: SidebarFocusTarget | null) => {
        focusController.focusOn(target);
        onFocusElsewhere();
      },
    };
  }, [rootFolders, onFocusElsewhere, focusController]);
  const focus = focusController.focus;
  const { t } = useTranslation();
  const focusTrail = useMemo(
    () =>
      focus
        ? sidebarFocusTrail({
            target: focus,
            world: focusWorld,
            labels: {
              allProjects: t("sidebar.focus.allProjects"),
              standing: "Standing",
              factory: t("projectFactory.folder"),
              pinned: t("sidebar.pinned.title"),
            },
          })
        : null,
    [focus, focusWorld, t],
  );
  // Focus unfolds the folders on its path in this view only; stored folding never changes.
  const viewFolderState = useMemo(
    () =>
      focus && folderState ? expandSidebarFocusPath(folderState, focus, focusWorld) : folderState,
    [focus, folderState, focusWorld],
  );
  const dragSession = useSidebarDragSession((state) => state.session);
  // A drag folds the view, never the stored state, so its end restores folding exactly.
  const listFolderState = useMemo(
    () => (viewFolderState ? dragViewFolderState(viewFolderState, dragSession) : null),
    [viewFolderState, dragSession],
  );
  const listCollapsedProjectKeys = useMemo(
    () =>
      dragViewCollapsedProjects(
        collapsedProjectKeys,
        projects.map(projectViewKeyExtractor),
        dragSession,
      ),
    [collapsedProjectKeys, projects, dragSession],
  );
  const focusProjectKey = focus ? sidebarFocusProjectKey(focus, focusWorld) : null;
  const projectBlockFocus = useMemo((): SidebarProjectBlockFocus | null => {
    if (!focus || focusProjectKey === null) return null;
    if (focus.kind === "folder") return { kind: "folder", folderId: focus.folderId };
    if (focus.kind === "section") return { kind: "section", section: focus.section };
    return { kind: "project" };
  }, [focus, focusProjectKey]);
  return {
    pinnedFactoryCards,
    focusContext: rootFolders ? focusController : focusElsewhere,
    focus,
    focusWorld,
    focusTrail,
    listFolderState,
    listCollapsedProjectKeys,
    focusProjectKey,
    projectBlockFocus,
  };
}

function ProjectModeListContent({
  onContentSizeChange,
  onScrolledChange,
  projects,
  pinnedGroups,
  workspaceEntriesByKey,
  projectIconByProjectViewKey,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  onWorkspacePress,
  onAddProject,
  onImportSession,
  listFooterComponent,
  listTopComponent,
  listHeaderComponent,
  sidebarFilterEmpty,
  hasActiveProjectFilter,
  parentGestureRef,
  dragGestureHostActive,
  pathname,
  hostBadgeByServerId,
  supportsMultiplicityByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  onPinnedWorkspaceReorder,
  rootFolders = true,
  onFocusElsewhere,
}: Omit<
  SidebarWorkspaceListProps,
  | "workspaceGroups"
  | "projectIconTargets"
  | "groupMode"
  | "hasProjectsBeforeFilter"
  | "isRefreshing"
  | "onRefresh"
> & {
  /** Swaps the list body for the label filter's empty state. Never the header above it. */
  sidebarFilterEmpty: boolean;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  pathname: string;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onPinnedWorkspaceReorder: (workspaces: SidebarWorkspacePlacement[]) => void;
}) {
  const onScroll = useScrollReporter(onScrolledChange);
  const pinnedExternalDrop = useWorkspaceProjectDrop();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const [creatingWorkspaceIds, setCreatingWorkspaceIds] = useState<Set<string>>(() => new Set());
  const creatingWorkspaceTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const showShortcutBadges = useShowShortcutBadges();
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const togglePinnedCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.togglePinnedCollapsed,
  );

  const foldersSupported = useSidebarFoldersSupported();
  const storedFolders = useSidebarFolderStore();
  const folderState = foldersSupported ? storedFolders : null;
  const rootFolderState = rootFolders ? folderState : null;
  const hasActiveLabelFilter = useSidebarViewStore((state) =>
    hasActiveSidebarLabelFilter(state.labelFilter),
  );
  // A filter narrows what is listed, so folders it leaves empty would be noise.
  const hideEmptyFolders = hasActiveHostFilter || hasActiveProjectFilter || hasActiveLabelFilter;

  const {
    pinnedFactoryCards,
    focusContext,
    focus,
    focusWorld,
    focusTrail,
    listFolderState,
    listCollapsedProjectKeys,
    focusProjectKey,
    projectBlockFocus,
  } = useProjectModeView({
    projects,
    workspaceEntriesByKey,
    folderState,
    hideEmptyFolders,
    rootFolders,
    collapsedProjectKeys,
    onFocusElsewhere,
    hasPinned: pinnedGroups.pinnedChats.length > 0,
  });
  const pinnedFocused = focus?.kind === "pinned";

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder);
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder);
  const manualSort = useSidebarViewStore((state) => state.workspaceSort === "manual");
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder);
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder);

  const isWorkspaceRoute = useMemo(
    () => Boolean(pathname && parseHostWorkspaceRouteFromPathname(pathname)),
    [pathname],
  );
  const selectionEnabled = isWorkspaceRoute;
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const { pinnedChats } = pinnedGroups;
  const {
    leadingItem: leadingPinnedChat,
    visibleItems: visiblePinnedChats,
    expanded: pinnedChatsExpanded,
    canToggle: canTogglePinnedChats,
    toggleExpanded: togglePinnedChatsExpanded,
  } = useLimitedSidebarGroup({
    items: pinnedChats,
    selection: selectionEnabled ? activeWorkspaceSelection : null,
  });
  const nativeScrollGestureProps = useMemo(
    () =>
      parentGestureRef
        ? ({
            // NestableScrollContainer forwards props to RNGH ScrollView. Keep
            // vertical scroll and sidebar close pan simultaneous: vertical
            // intent scrolls immediately, clear horizontal intent can still
            // activate close from inside the list.
            simultaneousHandlers: parentGestureRef,
          } as object)
        : undefined,
    [parentGestureRef],
  );

  useEffect(() => {
    const timeouts = creatingWorkspaceTimeoutsRef.current;
    return () => {
      for (const timeout of timeouts.values()) {
        clearTimeout(timeout);
      }
      timeouts.clear();
    };
  }, []);

  useEffect(() => {
    if (creatingWorkspaceIds.size === 0) {
      return;
    }

    const visibleWorkspaceIds = new Set<string>();
    for (const project of projects) {
      for (const workspace of project.workspaces) {
        visibleWorkspaceIds.add(workspace.workspaceId);
      }
    }

    const removedWorkspaceIds = Array.from(creatingWorkspaceIds).filter(
      (workspaceId) => !visibleWorkspaceIds.has(workspaceId),
    );
    if (removedWorkspaceIds.length === 0) {
      return;
    }

    for (const workspaceId of removedWorkspaceIds) {
      const timeout = creatingWorkspaceTimeoutsRef.current.get(workspaceId);
      if (timeout) {
        clearTimeout(timeout);
        creatingWorkspaceTimeoutsRef.current.delete(workspaceId);
      }
    }

    setCreatingWorkspaceIds((current) => {
      const next = new Set(current);
      for (const workspaceId of removedWorkspaceIds) {
        next.delete(workspaceId);
      }
      return next;
    });
  }, [creatingWorkspaceIds, projects]);

  const rootRows = useMemo(() => {
    // Pinned chats stay in their projects as well as under Pinned, so focus loses nothing.
    const rows = buildSidebarTreeRows({
      state: (rootFolders ? listFolderState : null) ?? EMPTY_SIDEBAR_FOLDER_STATE,
      scope: ROOT_FOLDER_SCOPE,
      items: projects,
      getKey: projectViewKeyExtractor,
      hideEmptyFolders,
    });
    return focus ? sidebarFocusRootRows(rows, focus, focusWorld) : rows;
  }, [rootFolders, listFolderState, focus, focusWorld, projects, hideEmptyFolders]);

  const saveProjectOrder = useCallback(
    (reorderedProjectKeys: string[]) => {
      const currentProjectOrder = getProjectOrder();
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        })
      ) {
        return;
      }

      setProjectOrder(
        mergeWithRemainder({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        }),
      );
    },
    [getProjectOrder, setProjectOrder],
  );

  const handleProjectDragEnd = useCallback(
    (rows: SidebarTreeRow<SidebarProjectEntry>[], movedKey: string) => {
      if (rootFolderState) {
        reorderSidebarRows({ scope: ROOT_FOLDER_SCOPE, rows, movedKey });
        return;
      }
      saveProjectOrder(treeRowItems(rows).map(projectViewKeyExtractor));
    },
    [rootFolderState, saveProjectOrder],
  );

  const handleRootDrop = useCallback(
    (dragged: SidebarDropRow, placement: SidebarDropPlacement) => {
      if (rootFolderState) {
        placeSidebarEntry({
          scope: ROOT_FOLDER_SCOPE,
          entry: dragged.key,
          targetFolderId:
            placement.container === null ? null : folderIdOfEntry(placement.container),
          before: placement.beforeKey,
          after: placement.afterKey,
          keys: projects.map(projectViewKeyExtractor),
        });
        return;
      }
      const keys = treeRowItems(rootRows).map(projectViewKeyExtractor);
      saveProjectOrder(reorderKeys(keys, dragged.key, placement));
    },
    [rootFolderState, rootRows, projects, saveProjectOrder],
  );
  const rootDropTop = useMemo(
    () => (focus ? sidebarFocusRootDropTop(focus, focusWorld) : null),
    [focus, focusWorld],
  );
  const rootFocusOffset = sidebarFocusRootLevelOffset(focus, focusWorld);
  const rootTreeDrop = useSidebarTreeDrop({
    items: rootRows,
    describe: describeRootRow,
    top: rootDropTop,
    baseLevel: rootFocusOffset,
    outside: "clamp",
    onDrop: handleRootDrop,
  });

  const handleWorkspaceReorder = useCallback(
    (projectViewKey: string, reorderedWorkspaces: SidebarWorkspacePlacement[]) => {
      const reorderedWorkspaceKeys = reorderedWorkspaces.map((workspace) => workspace.workspaceKey);
      const currentWorkspaceOrder = getWorkspaceOrder(projectViewKey);
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        })
      ) {
        return;
      }

      setWorkspaceOrder(
        projectViewKey,
        mergeWithRemainder({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        }),
      );
    },
    [getWorkspaceOrder, setWorkspaceOrder],
  );

  const handleWorktreeCreated = useCallback((workspaceId: string) => {
    setCreatingWorkspaceIds((current) => {
      const next = new Set(current);
      next.add(workspaceId);
      return next;
    });
    const existingTimeout = creatingWorkspaceTimeoutsRef.current.get(workspaceId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    creatingWorkspaceTimeoutsRef.current.set(
      workspaceId,
      setTimeout(() => {
        creatingWorkspaceTimeoutsRef.current.delete(workspaceId);
        setCreatingWorkspaceIds((current) => {
          if (!current.has(workspaceId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(workspaceId);
          return next;
        });
      }, 3000),
    );
  }, []);

  const renderProjectBlock = useCallback(
    (
      item: SidebarProjectEntry,
      dragState: {
        drag: () => void;
        isDragging: boolean;
        dragHandleProps?: DraggableRenderItemInfo<SidebarProjectEntry>["dragHandleProps"];
      },
    ) => {
      return (
        <MemoProjectBlock
          key={item.viewKey}
          project={item}
          workspaceEntriesByKey={workspaceEntriesByKey}
          collapsed={focusProjectKey !== item.viewKey && listCollapsedProjectKeys.has(item.viewKey)}
          displayName={item.projectName}
          iconDataUri={projectIconByProjectViewKey.get(item.viewKey) ?? null}
          selectionEnabled={selectionEnabled}
          showShortcutBadges={showShortcutBadges}
          shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
          onToggleCollapsed={onToggleProjectCollapsed}
          onWorkspacePress={onWorkspacePress}
          manualSort={manualSort}
          parentGestureRef={parentGestureRef}
          onWorkspaceReorder={handleWorkspaceReorder}
          useNestable={platformIsNative}
          dragGestureHostActive={dragGestureHostActive}
          onWorktreeCreated={handleWorktreeCreated}
          drag={dragState.drag}
          isDragging={dragState.isDragging}
          dragHandleProps={dragState.dragHandleProps}
          creatingWorkspaceIds={creatingWorkspaceIds}
          activeWorkspaceSelection={activeWorkspaceSelection}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsMultiplicityByServerId={supportsMultiplicityByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
          folderState={listFolderState}
          hideEmptyFolders={hideEmptyFolders}
          focus={focusProjectKey === item.viewKey ? projectBlockFocus : null}
        />
      );
    },
    [
      listFolderState,
      listCollapsedProjectKeys,
      focusProjectKey,
      projectBlockFocus,
      hideEmptyFolders,
      activeWorkspaceSelection,
      handleWorktreeCreated,
      manualSort,
      parentGestureRef,
      dragGestureHostActive,
      handleWorkspaceReorder,
      hostBadgeByServerId,
      supportsMultiplicityByServerId,
      supportsPinningByServerId,
      onToggleWorkspacePin,
      onWorkspacePress,
      onToggleProjectCollapsed,
      projectIconByProjectViewKey,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      workspaceEntriesByKey,
      creatingWorkspaceIds,
    ],
  );

  const renderProject = useCallback(
    ({
      item: row,
      drag,
      isActive,
      dragHandleProps,
    }: DraggableRenderItemInfo<SidebarTreeRow<SidebarProjectEntry>>) => {
      const depth = row.depth + rootFocusOffset;
      if (row.kind === "folder") {
        return (
          <SidebarFolderRow
            row={row}
            scope={ROOT_FOLDER_SCOPE}
            level={depth}
            drag={drag}
            isDragging={isActive}
            dragHandleProps={dragHandleProps}
          />
        );
      }
      const block = renderProjectBlock(row.item, {
        drag,
        isDragging: isActive,
        dragHandleProps,
      });
      return depth > 0 ? <View style={sidebarNestingStyle(depth)}>{block}</View> : block;
    },
    [renderProjectBlock, rootFocusOffset],
  );

  const renderPinnedChatRow = useCallback(
    (
      workspace: SidebarWorkspacePlacement,
      input?: {
        drag?: () => void;
        isDragging?: boolean;
        dragHandleProps?: DraggableListDragHandleProps;
      },
    ) => (
      <MemoWorkspaceRowItem
        key={workspace.workspaceKey}
        workspace={workspace}
        workspaceEntry={workspaceEntriesByKey.get(workspace.workspaceKey) ?? null}
        hostBadge={hostBadgeByServerId.get(workspace.serverId) ?? null}
        leadingProjectName={workspace.projectName}
        // Pinned rows sit one level inside the Pinned heading; focused, they are the top level.
        indentLevel={pinnedFocused ? 0 : 1}
        leadingProjectIconDataUri={
          projectIconByProjectViewKey.get(workspace.projectViewKey) ?? null
        }
        shortcutNumber={shortcutIndexByWorkspaceKey.get(workspace.workspaceKey) ?? null}
        showShortcutBadge={showShortcutBadges}
        canCopyBranchName={workspace.projectKind === "git"}
        canPin={supportsPinningByServerId.get(workspace.serverId) === true}
        onToggleWorkspacePin={onToggleWorkspacePin}
        isCreating={creatingWorkspaceIds.has(workspace.workspaceId)}
        selectionEnabled={selectionEnabled}
        activeWorkspaceSelection={activeWorkspaceSelection}
        onWorkspacePress={onWorkspacePress}
        drag={input?.drag}
        isDragging={input?.isDragging}
        dragHandleProps={input?.dragHandleProps}
      />
    ),
    [
      activeWorkspaceSelection,
      creatingWorkspaceIds,
      hostBadgeByServerId,
      onWorkspacePress,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      supportsPinningByServerId,
      onToggleWorkspacePin,
      pinnedFocused,
      projectIconByProjectViewKey,
      workspaceEntriesByKey,
    ],
  );

  const renderPinnedChat = useCallback(
    ({
      item,
      drag,
      isActive,
      dragHandleProps,
    }: DraggableRenderItemInfo<SidebarWorkspacePlacement>) =>
      renderPinnedChatRow(item, {
        drag,
        isDragging: isActive,
        dragHandleProps,
      }),
    [renderPinnedChatRow],
  );

  const focusActions = useMemo(
    () =>
      focus ? (
        <SidebarFocusActions
          focus={focus}
          world={focusWorld}
          projects={projects}
          supportsMultiplicityByServerId={supportsMultiplicityByServerId}
          onWorkspacePress={onWorkspacePress}
          part="menu"
        />
      ) : null,
    [focus, focusWorld, projects, supportsMultiplicityByServerId, onWorkspacePress],
  );
  const focusCreateAction = useMemo(
    () =>
      focus ? (
        <SidebarFocusActions
          focus={focus}
          world={focusWorld}
          projects={projects}
          supportsMultiplicityByServerId={supportsMultiplicityByServerId}
          onWorkspacePress={onWorkspacePress}
          part="create"
        />
      ) : null,
    [focus, focusWorld, projects, supportsMultiplicityByServerId, onWorkspacePress],
  );

  const showListHeader = useMemo(
    () =>
      projects.length > 0 || hasActiveHostFilter || hasActiveProjectFilter || sidebarFilterEmpty,
    [projects.length, hasActiveHostFilter, hasActiveProjectFilter, sidebarFilterEmpty],
  );
  const projectBody =
    projects.length === 0 ? (
      <SidebarProjectEmptyState onAddProject={onAddProject} onImportSession={onImportSession} />
    ) : (
      <DraggableList
        testID="sidebar-project-list"
        treeDrop={isWeb ? rootTreeDrop : undefined}
        data={rootRows}
        keyExtractor={treeRowKeyExtractor}
        renderItem={renderProject}
        onDragEnd={handleProjectDragEnd}
        extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
        scrollEnabled={false}
        useDragHandle
        nestable={platformIsNative}
        simultaneousGestureRef={parentGestureRef}
        gestureHostPresented={dragGestureHostActive}
        containerStyle={styles.projectListContainer}
      />
    );

  // Rows dissolve under the dividers above and below the list while more lies past them.
  const listReach = useSidebarListReachReporter(onContentSizeChange);
  // Shared by the Pinned section and the focused Pinned view, which lists them under its
  // breadcrumb in place of the projects.
  const pinnedRows = (
    <>
      {pinnedFactoryCards.map(({ card, projectName }) => (
        <FactorySection
          key={card.key}
          card={card}
          entries={workspaceEntriesByKey}
          projectName={projectName}
          level={pinnedFocused ? 0 : 1}
          activeWorkspaceSelection={activeWorkspaceSelection}
          selectionEnabled={selectionEnabled}
          canPinWorkspace={supportsPinningByServerId.get(card.serverId) === true}
          onToggleWorkspacePin={onToggleWorkspacePin}
          onWorkspacePress={onWorkspacePress}
        />
      ))}
      {leadingPinnedChat ? renderPinnedChatRow(leadingPinnedChat) : null}
      <DraggableList
        testID="sidebar-pinned-list"
        externalDrop={pinnedExternalDrop}
        data={visiblePinnedChats}
        keyExtractor={workspaceKeyExtractor}
        renderItem={renderPinnedChat}
        onDragEnd={onPinnedWorkspaceReorder}
        extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
        scrollEnabled={false}
        useDragHandle
        nestable={platformIsNative}
        simultaneousGestureRef={parentGestureRef}
        gestureHostPresented={dragGestureHostActive}
        containerStyle={styles.workspaceListContainer}
      />
      {canTogglePinnedChats ? (
        <SidebarGroupToggleRow
          expanded={pinnedChatsExpanded}
          onPress={togglePinnedChatsExpanded}
          testID="sidebar-pinned-show-more"
        />
      ) : null}
    </>
  );
  const listBody = sidebarFilterEmpty ? <SidebarFilterEmptyState /> : projectBody;

  const content = (
    <>
      {listTopComponent}
      {/* The main sidebar only; a single project's rail flyout has no global section. */}
      <AllFactoriesSection
        mainSidebar={rootFolders}
        focused={focus !== null}
        onBeforeNavigate={onWorkspacePress}
      />
      {pinnedChats.length + pinnedFactoryCards.length > 0 && focus === null ? (
        <View style={styles.pinnedSection} testID="sidebar-pinned-section">
          <PinnedSectionRow
            count={pinnedChats.length + pinnedFactoryCards.length}
            collapsed={pinnedCollapsed}
            onToggle={togglePinnedCollapsed}
          />
          <SidebarDisclosureBody expanded={!pinnedCollapsed}>{pinnedRows}</SidebarDisclosureBody>
        </View>
      ) : null}
      {/* The header carries the display menu, which is the only way back out of a filter, so it
        stays for as long as a filter is what emptied the list. It is absent only when the
        sidebar is genuinely empty, where a section heading would sit over nothing.
        Every filter that can empty this branch needs a term here; without its term the header
        would go with it, taking the only route back to the filter page. */}
      {showListHeader ? listHeaderComponent : null}
      {focusTrail ? (
        <SidebarFocusBreadcrumb
          trail={focusTrail}
          actions={focusActions}
          persistentActions={focusCreateAction}
        />
      ) : null}
      {/* Folder and Show more changes alter this flat list's measured height. */}
      <SidebarDisclosureBody expanded>
        {pinnedFocused ? pinnedRows : listBody}
      </SidebarDisclosureBody>
      {listFooterComponent}
    </>
  );

  return (
    <SidebarFocusProvider value={focusContext}>
      <ProjectFactoryDialog />
      <FactoryInstructionsPanel />
      <View style={styles.container}>
        {platformIsNative ? (
          <NestableScrollContainer
            {...nativeScrollGestureProps}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onLayout={listReach.onLayout}
            onContentSizeChange={listReach.onContentSizeChange}
            testID="sidebar-project-workspace-list-scroll"
          >
            <NestableScrollDivider onChange={onScrolledChange} />
            {content}
          </NestableScrollContainer>
        ) : (
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onLayout={listReach.onLayout}
            onContentSizeChange={listReach.onContentSizeChange}
            testID="sidebar-project-workspace-list-scroll"
          >
            {content}
          </ScrollView>
        )}
      </View>
    </SidebarFocusProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    // The enclosing panel owns adaptive insets, as it does for right-hand cards.
    // Optical inset: aligns the visible Pinned/Workspaces glyph edge with the
    // Schedules icon across the divider; their layout boxes have different insets.
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  projectListContainer: {
    width: "100%",
  },
  pinnedSection: {
    marginBottom: theme.spacing[1],
  },
  // Three times the gap a row keeps from its neighbour, so the break between two groups reads as
  // a break rather than as one more row of pitch. Kept equal to `statusGroupBlockExpanded` — the
  // two groupings are the same list under a different heading and must not breathe differently.
  //
  // Padding on the block rather than margin, and only while it has children: the gap belongs to
  // the rows underneath the header, so a collapsed project gives it back and a column of collapsed
  // headers closes up to the pitch of a list instead of staying spaced for content that is gone.
  workspaceListContainer: {},
  // Kept in step with `workspaceRow` above. It stands in a project's list where a workspace row
  // would be, so it takes that row's geometry and both of its fills.
  //
  // The one departure is the extra left padding: it only ever renders under its project header, so
  // the step in reads as belonging to that project. Padding rather than margin, so the hover and
  // pressed fills stay the same box as every other row in the sidebar.
  newWorkspaceGhostRow: {
    minHeight: densityTokens.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
    ...hoverGroup(NEW_WORKSPACE_ROW_HOVER_GROUP),
  },
  newWorkspaceGhostRowHoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
  newWorkspaceGhostRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  // The width of a workspace row's status slot, so the label lands on the same rail as the
  // titles above it.
  newWorkspaceGhostIconSlot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    // The plus strokes with this color on web.
    ...groupHoverStyle(
      NEW_WORKSPACE_ROW_HOVER_GROUP,
      { color: theme.colors.foreground },
      { color: theme.colors.foregroundMuted },
    ),
  },
  newWorkspaceGhostIconSlotPressed: { _web: { color: theme.colors.foreground } },
  newWorkspaceGhostText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
    ...groupHoverStyle(NEW_WORKSPACE_ROW_HOVER_GROUP, { color: theme.colors.foreground }),
  },
  newWorkspaceGhostTextPressed: { color: theme.colors.foreground },
  projectRow: {
    position: "relative",
    minHeight: densityTokens.rowHeight,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingLeft: SIDEBAR_ROW_INSET,
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  projectRowMain: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    justifyContent: "center",
  },
  // The leading group swaps the project icon for the disclosure arrow on CSS hover.
  projectRowGroup: hoverGroup([PROJECT_ROW_HOVER_GROUP, SIDEBAR_LEADING_HOVER_GROUP]),
  // Publishes the row's surface so the project badge cutout follows its CSS hover fill.
  projectRowHoverable: hoverSurface(theme.colors.surfaceSidebar, theme.colors.surfaceSidebarHover),
  projectRowPressed: {
    backgroundColor: theme.colors.surface2,
    ...rowSurface(theme.colors.surface2),
  },
  projectRowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
    ...rowSurface(theme.colors.surface2),
  },
  projectRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  projectTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  // Groups the project's trailing summary and actions so a calm row can dim them together.
  projectTrailingGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  calmTitle: { color: theme.colors.foregroundExtraMuted },
  calmTrailing: { opacity: SIDEBAR_CALM_OPACITY },
  projectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  projectActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  projectActionButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  projectActionButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  projectIconActionButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    // The plus strokes with this color on web.
    _web: { color: theme.colors.foregroundMuted },
  },
  // Small actions inside sidebar rows hover one step above the row's own hover, like the kebab.
  projectIconActionButtonHoverable: hoverStyle({
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
  }),
  projectIconActionButtonPressed: {
    backgroundColor: theme.colors.interactionHighlight,
    _web: { color: theme.colors.foreground },
  },
  // Project actions stay mounted; CSS shows them while the project row is hovered or focused.
  projectActionReveal: revealOnGroupHover(PROJECT_ROW_HOVER_GROUP),
  projectTaskSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  projectTrailingActionsVorton: {
    flexDirection: "row-reverse",
    marginRight: 0,
    gap: 4,
  },
  projectTrailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    // MoreVertical paints only around the center of its 14px SVG. Keep the 24px controls,
    // but pull their painted edge through the unused view-box space onto the row rail.
    marginRight: -6,
  },
  projectKebabButton: {
    // Larger on compact so the kebab is an easy tap target. The negative margins keep its
    // dots on the same rail as the 24px desktop box and the row at its 44px height.
    width: { xs: 32, md: 24 },
    height: { xs: 32, md: 24 },
    marginRight: { xs: -4, md: 0 },
    marginVertical: { xs: -4, md: 0 },
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    // The kebab strokes with this color on web.
    ...hoverStyle(
      { backgroundColor: theme.colors.surface2, color: theme.colors.foreground },
      { color: theme.colors.foregroundMuted },
    ),
  },
  projectTrailingControlSlot: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectActionTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectActionTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  projectActionTooltipShortcut: {},
  projectShortcutBadgeOverlay: {
    position: "absolute",
    top: theme.spacing[2] + 1,
    right: theme.spacing[2],
  },
  workspaceRow: {
    minHeight: densityTokens.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    width: "100%",
  },
  workspaceRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  workspaceRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  // Publishes the row's surface so status rings and badge cutouts follow its CSS hover fill.
  workspaceRowHoverable: hoverSurface(
    theme.colors.surfaceSidebar,
    theme.colors.surfaceSidebarHover,
  ),
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
    ...rowSurface(theme.colors.surface2),
  },
  workspaceRowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
    ...rowSurface(theme.colors.surface2),
  },
  // Shared by project and workspace rows; publishes the surface their knockout marks follow.
  sidebarRowSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
    ...rowSurface(theme.colors.surfaceSidebarSelected),
  },
  workspaceRowContainer: {
    position: "relative",
    ...hoverGroup(SIDEBAR_WORKSPACE_HOVER_GROUP),
  },
  workspaceStatusDot: {
    position: "relative",
    width: WORKSPACE_STATUS_DOT_WIDTH,
    height: 16,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceArchivingOverlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: `${theme.colors.surface0}cc`,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    zIndex: 1,
  },
  workspaceArchivingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  workspaceBranchText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
  workspaceBranchTextCreating: {
    opacity: 0.92,
  },
  workspaceBranchTextHovered: {
    opacity: 1,
  },
  workspacePrBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: WORKSPACE_STATUS_DOT_WIDTH + theme.spacing[2],
  },
  workspaceCreatingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  kebabButton: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
  },
  kebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
