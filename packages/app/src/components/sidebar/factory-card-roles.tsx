import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceRenameModal } from "@/components/workspace-rename-modal";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import {
  navigateToWorkspace,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { hoverStyle } from "@/styles/hover";
import { LIST_ROW_HEIGHT, LIST_ROW_TOUCH_HEIGHT } from "@/styles/list-row-metrics";
import { isNative } from "@/constants/platform";
import { useVortonTouch } from "@/vorton-touch";
import { useWorkspaceMenuActions } from "@/workspace/use-workspace-menu-actions";
import { fallbackFactoryRoleTitle, PROJECT_FACTORY_ROLE_IDS } from "./factory-role-ids";
import type { ProjectFactoryState } from "./factory-state";
import { factoryShortName } from "./factory-card-model";
import { useFactoryStatusAge } from "./factory-status";
import { freshFactoryStatus } from "./project-factory-model";
import { SidebarWorkspaceContextMenu } from "./sidebar-workspace-menu";
import { WorkspaceStatusIndicator, isSidebarRowCalm } from "./sidebar-workspace-row-content";

type RoleStatus = ProjectFactoryState["roles"][number]["status"];

export interface FactoryChip {
  key: string;
  label: string;
  entry: SidebarWorkspaceEntry | null;
  /** Undefined for members that are not roles, which report no status. */
  status: RoleStatus | undefined;
  isRole: boolean;
}

/**
 * One chip per Factory role, in the daemon's order, then any other Factory members. Before the
 * daemon's state arrives, members stand in with display-only role names.
 */
export function factoryChips(
  roles: ProjectFactoryState["roles"] | undefined,
  members: readonly SidebarWorkspaceEntry[],
): FactoryChip[] {
  const chips: FactoryChip[] = (roles ?? []).map((role) => ({
    key: role.role,
    label: factoryShortName(role.title),
    entry: members.find((member) => member.workspaceId === role.workspaceId) ?? null,
    status: role.status,
    isRole: true,
  }));
  const claimed = new Set((roles ?? []).flatMap((role) => role.workspaceId ?? []));
  for (const member of members) {
    if (claimed.has(member.workspaceId)) continue;
    const fallbackRole = roles
      ? undefined
      : PROJECT_FACTORY_ROLE_IDS.find((role) =>
          member.name.endsWith(`:: ${fallbackFactoryRoleTitle(role)}`),
        );
    chips.push({
      key: member.workspaceKey,
      label: factoryShortName(member.name),
      entry: member,
      status: undefined,
      isRole: fallbackRole !== undefined,
    });
  }
  return chips;
}

export function FactoryRoleChips({
  chips,
  activeWorkspaceSelection,
  selectionEnabled,
  canPinWorkspace,
  onToggleWorkspacePin,
  onWorkspacePress,
}: {
  chips: readonly FactoryChip[];
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  selectionEnabled: boolean;
  canPinWorkspace: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onWorkspacePress?: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={styles.grid} testID="factory-card-roles">
      {chips.map((chip) => (
        <View key={chip.key} pointerEvents="box-none" style={styles.cell}>
          {chip.entry ? (
            <WorkspaceChip
              chip={chip}
              workspace={chip.entry}
              selected={
                selectionEnabled &&
                activeWorkspaceSelection?.serverId === chip.entry.serverId &&
                activeWorkspaceSelection.workspaceId === chip.entry.workspaceId
              }
              canPin={canPinWorkspace}
              onToggleWorkspacePin={onToggleWorkspacePin}
              onWorkspacePress={onWorkspacePress}
            />
          ) : (
            <View pointerEvents="none" style={[styles.chip, styles.chipEmpty]}>
              <View style={styles.indicatorSlot} />
              <Text style={[styles.chipText, styles.chipTextMuted]} numberOfLines={1}>
                {chip.label}
              </Text>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

function ChipTooltipText({ chip }: { chip: FactoryChip }) {
  const { t } = useTranslation();
  const status = freshFactoryStatus(chip.status) ?? undefined;
  const age = useFactoryStatusAge(status);
  if (status && age) {
    return <TooltipText label={t("sidebar.factoryCard.statusAge", { line: status.line, age })} />;
  }
  return (
    <TooltipText
      label={chip.isRole ? t("sidebar.factoryCard.noStatus") : (chip.entry?.name ?? chip.label)}
    />
  );
}

/** A role's workspace: it opens, menus and reports status exactly as the workspace row would. */
function WorkspaceChip({
  chip,
  workspace,
  selected,
  canPin,
  onToggleWorkspacePin,
  onWorkspacePress,
}: {
  chip: FactoryChip;
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const actions = useWorkspaceMenuActions({
    workspace,
    selected,
    canPin,
    onToggleWorkspacePin,
  });
  const handlePress = useCallback(() => {
    // Lets a host surface such as the rail flyout close before the route changes.
    onWorkspacePress?.();
    navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
  }, [onWorkspacePress, workspace.serverId, workspace.workspaceId]);
  const touch = useVortonTouch() || isNative;
  const calm = isSidebarRowCalm({ selected, hovered: false, bucket: workspace.statusBucket });
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const chipStyle = useMemo(
    () => [
      styles.chip,
      touch && styles.chipTouch,
      selected ? styles.chipSelected : styles.chipHoverable,
    ],
    [selected, touch],
  );
  return (
    <>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View collapsable={false} style={styles.triggerSlot}>
            <SidebarWorkspaceContextMenu
              contextMenuOpen={contextMenuOpen}
              onContextMenuOpenChange={setContextMenuOpen}
              workspace={workspace}
              workspaceKey={workspace.workspaceKey}
              onCopyPath={actions.handleCopyPath}
              onCopyBranchName={workspace.currentBranch ? actions.handleCopyBranchName : undefined}
              onRename={actions.handleOpenRename}
              onMarkAsRead={actions.hasClearableAttention ? actions.handleMarkAsRead : undefined}
              onMarkAsUnread={actions.canMarkUnread ? actions.handleMarkAsUnread : undefined}
              onArchive={actions.handleArchive}
              archiveLabel={t("sidebar.workspace.actions.archive")}
              archiveStatus={actions.isArchiving ? "pending" : "idle"}
              archivePendingLabel={t("sidebar.workspace.actions.archiving")}
              isPinned={actions.isPinned}
              onTogglePin={actions.onTogglePin}
              openInFileManagerPath={workspace.workspaceDirectory}
              disabled={actions.isArchiving}
              accessibilityRole="button"
              accessibilityLabel={t("sidebar.factoryCard.openRole", { role: chip.label })}
              accessibilityState={accessibilityState}
              aria-selected={selected}
              style={chipStyle}
              highlightStyle={styles.chipPressed}
              onPress={handlePress}
              testID={`factory-card-role-${workspace.workspaceKey}`}
            >
              <View style={styles.indicatorSlot}>
                <WorkspaceStatusIndicator
                  serverId={workspace.serverId}
                  workspaceId={workspace.workspaceId}
                  bucket={workspace.statusBucket}
                  workspaceKind={workspace.workspaceKind}
                  loading={actions.isArchiving}
                  muted={calm}
                  lit={!calm}
                />
              </View>
              <Text style={[styles.chipText, calm && styles.chipTextMuted]} numberOfLines={1}>
                {chip.label}
              </Text>
            </SidebarWorkspaceContextMenu>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" maxWidth={300}>
          <ChipTooltipText chip={chip} />
        </TooltipContent>
      </Tooltip>
      <WorkspaceRenameModal
        visible={actions.isRenameOpen}
        workspace={workspace}
        onClose={actions.handleCloseRename}
        testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    rowGap: theme.spacing[1],
  },
  // Two columns; the gutter is the cells' padding so wrapping never leaves a ragged gap.
  cell: {
    width: "50%",
    paddingHorizontal: 2,
  },
  triggerSlot: { width: "100%" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: LIST_ROW_HEIGHT - 4,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: "transparent",
    backgroundColor: theme.colors.surface2,
  },
  chipTouch: { minHeight: LIST_ROW_TOUCH_HEIGHT },
  chipHoverable: hoverStyle({
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  }),
  chipSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
    borderColor: theme.colors.borderAccent,
  },
  chipPressed: { backgroundColor: theme.colors.surface3 },
  chipEmpty: { opacity: 0.6 },
  indicatorSlot: {
    minWidth: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  chipTextMuted: { color: theme.colors.foregroundMuted },
}));

/** Shared with the All Factories card, whose per-Factory chips take the same shape. */
export { styles as factoryChipStyles };
