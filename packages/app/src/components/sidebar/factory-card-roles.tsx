import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MessageCircle } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { sidebarIndent } from "./indent";
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

const ThemedMessage = withUnistyles(MessageCircle);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const talkIcon = <ThemedMessage size={12} uniProps={accentColor} />;

/** Gutter between tiles, on each side of a cell. */
const CELL_GUTTER = 2;
const TILE_PADDING = 8;
/** Cell gutter, tile border and tile padding before a tile's status icon. */
const TILE_ICON_INSET = CELL_GUTTER + 1 + TILE_PADDING;

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

/** The Foreman is the place to talk to the Factory, so it leads; the other members are its crew. */
export function splitForeman(chips: readonly FactoryChip[]): {
  foreman: FactoryChip | null;
  crew: FactoryChip[];
} {
  const foreman =
    chips.find((chip) => chip.key === "factory-intake") ??
    chips.find(
      (chip) => chip.isRole && chip.label === fallbackFactoryRoleTitle("factory-intake"),
    ) ??
    null;
  return { foreman, crew: chips.filter((chip) => chip !== foreman) };
}

interface ChipSelectionProps {
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  selectionEnabled: boolean;
  canPinWorkspace: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onWorkspacePress?: () => void;
}

function chipSelected(chip: FactoryChip, props: ChipSelectionProps): boolean {
  return Boolean(
    chip.entry &&
    props.selectionEnabled &&
    props.activeWorkspaceSelection?.serverId === chip.entry.serverId &&
    props.activeWorkspaceSelection.workspaceId === chip.entry.workspaceId,
  );
}

/**
 * Where a tile row starts so the status icon inside a tile shares the icon rail of sidebar rows
 * at `level`: the cell gutter, the tile border and the tile padding sit before the icon.
 */
export function factoryTileRowStyle(level: number) {
  return inlineUnistylesStyle({ paddingLeft: Math.max(0, sidebarIndent(level) - TILE_ICON_INSET) });
}

function FactoryTile({
  chip,
  primary = false,
  ...props
}: ChipSelectionProps & { chip: FactoryChip; primary?: boolean }) {
  return chip.entry ? (
    <WorkspaceChip
      chip={chip}
      workspace={chip.entry}
      primary={primary}
      selected={chipSelected(chip, props)}
      canPin={props.canPinWorkspace}
      onToggleWorkspacePin={props.onToggleWorkspacePin}
      onWorkspacePress={props.onWorkspacePress}
    />
  ) : (
    <View
      pointerEvents="none"
      style={[styles.chip, primary && styles.chipPrimary, styles.chipEmpty]}
    >
      <View style={styles.indicatorSlot} />
      <Text style={[styles.chipText, styles.chipTextMuted]} numberOfLines={1}>
        {chip.label}
      </Text>
    </View>
  );
}

/** The Foreman as a full-width tile that reads as the Factory's conversation. */
export function FactoryForemanTile({
  chip,
  level,
  ...props
}: ChipSelectionProps & { chip: FactoryChip; level: number }) {
  return (
    <View
      pointerEvents="box-none"
      style={[styles.grid, factoryTileRowStyle(level)]}
      testID="factory-card-foreman"
    >
      <View pointerEvents="box-none" style={styles.cellFull}>
        <FactoryTile chip={chip} primary {...props} />
      </View>
    </View>
  );
}

/** Two columns of quieter tiles, one per crew member. */
export function FactoryRoleChips({
  chips,
  level,
  ...props
}: ChipSelectionProps & { chips: readonly FactoryChip[]; level: number }) {
  if (chips.length === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.grid, factoryTileRowStyle(level)]}
      testID="factory-card-roles"
    >
      {chips.map((chip) => (
        <View key={chip.key} pointerEvents="box-none" style={styles.cell}>
          <FactoryTile chip={chip} {...props} />
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
  primary = false,
  workspace,
  selected,
  canPin,
  onToggleWorkspacePin,
  onWorkspacePress,
}: {
  chip: FactoryChip;
  /** The Foreman's full-width tile, marked as where to talk to the Factory. */
  primary?: boolean;
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
      primary && styles.chipPrimary,
      selected && (primary ? styles.chipPrimarySelected : styles.chipSelected),
      !selected && (primary ? styles.chipPrimaryHoverable : styles.chipHoverable),
    ],
    [selected, touch, primary],
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
              accessibilityLabel={
                primary
                  ? t("sidebar.factoryCard.talkLabel", { role: chip.label })
                  : t("sidebar.factoryCard.openRole", { role: chip.label })
              }
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
              <Text
                style={[
                  styles.chipText,
                  primary && styles.chipTextPrimary,
                  calm && !primary && styles.chipTextMuted,
                ]}
                numberOfLines={1}
              >
                {chip.label}
              </Text>
              {primary ? (
                <View style={styles.talk}>
                  {talkIcon}
                  <Text style={styles.talkText} numberOfLines={1}>
                    {t("sidebar.factoryCard.talk")}
                  </Text>
                </View>
              ) : null}
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
  // Rows of tiles end where sidebar rows end their content.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingRight: theme.spacing[2] - CELL_GUTTER,
    paddingBottom: theme.spacing[1],
    rowGap: theme.spacing[1],
  },
  // Two columns; the gutter is the cells' padding so wrapping never leaves a ragged gap.
  cell: {
    width: "50%",
    paddingHorizontal: CELL_GUTTER,
  },
  cellFull: { width: "100%", paddingHorizontal: CELL_GUTTER },
  triggerSlot: { width: "100%" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: LIST_ROW_HEIGHT - 4,
    paddingHorizontal: TILE_PADDING,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: "transparent",
    // Translucent, so tiles read on every theme's sidebar surface.
    backgroundColor: theme.colors.interactionHighlight,
  },
  chipPrimary: {
    backgroundColor: theme.colors.accentSubtle,
    borderColor: theme.colors.accent,
  },
  chipPrimaryHoverable: hoverStyle({ backgroundColor: theme.colors.accentSubtleHovered }),
  chipTouch: { minHeight: LIST_ROW_TOUCH_HEIGHT },
  chipHoverable: hoverStyle({
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  }),
  // Tiles already rest on a fill, so selection adds an outline as well as a stronger fill.
  chipSelected: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.foregroundMuted,
  },
  chipPrimarySelected: {
    backgroundColor: theme.colors.accentSubtleHovered,
    borderColor: theme.colors.accent,
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
  chipTextPrimary: { fontSize: theme.fontSize.base, fontWeight: theme.fontWeight.medium },
  talk: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
  talkText: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
}));

/** Shared with the All Factories card, whose per-Factory chips take the same shape. */
export { styles as factoryChipStyles };
