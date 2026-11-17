import { useCallback, useMemo, useState, type Ref } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { FolderInput, FolderPlus, MoreVertical, Pencil, Trash2 } from "lucide-react-native";
import type { SidebarFolder, SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import { sidebarFolderEntry } from "@getpaseo/protocol/sidebar-folders";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { SidebarCountBadge } from "@/components/sidebar/sidebar-count-badge";
import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";
import { useSidebarActionSize } from "@/components/sidebar/use-sidebar-action-size";
import { sidebarTrailingActionStyles } from "@/components/sidebar/trailing-actions";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useVortonTouch } from "@/vorton-touch";
import { sidebarIndentStyle } from "@/components/sidebar/indent";
import { sidebarContainerRowStyles } from "@/components/sidebar/container-row";
import {
  SIDEBAR_LEADING_HOVER_GROUP,
  SidebarFolderIcon,
  SidebarLeadingSlot,
  type SidebarDisclosure,
} from "@/components/sidebar/leading-slot";
import type { Theme } from "@/styles/theme";
import { hoverGroup, hoverStyle, revealOnGroupHover } from "@/styles/hover";
import {
  toggleSidebarFolderCollapsed,
  useCreateSidebarFolderAction,
  useMoveToSidebarFolderAction,
  useSidebarFolderDialog,
} from "./actions";
import { useRemoveSidebarFolder } from "./dialogs";
import { SidebarFocusButton } from "@/sidebar-focus/focus-button";
import { useSidebarRowFocus } from "@/sidebar-focus/context";
import type { SidebarFocusTarget } from "@/sidebar-focus/model";
import type { SidebarFolderRow as SidebarFolderRowModel } from "./tree";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedFolderInput = withUnistyles(FolderInput);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const newFolderIcon = <ThemedFolderPlus size={14} uniProps={mutedColorMapping} />;
const moveIcon = <ThemedFolderInput size={14} uniProps={mutedColorMapping} />;
const renameIcon = <ThemedPencil size={14} uniProps={mutedColorMapping} />;
const deleteIcon = <ThemedTrash2 size={14} uniProps={mutedColorMapping} />;

// On web the kebab strokes with the trigger's CSS color, so CSS hover recolors it.
const kebabIconMapping = isWeb ? () => ({ color: "currentColor" }) : mutedColorMapping;
const kebabIcon = <ThemedMoreVertical size={14} uniProps={kebabIconMapping} />;

/** Row hover group: the kebab reveals while the folder row is hovered or focused. */
const FOLDER_ROW_HOVER_GROUP = "folder-row";

type MenuSurface = "context" | "dropdown";

function folderChevron(isFocusRoot: boolean, collapsed: boolean): SidebarDisclosure {
  if (isFocusRoot) return null;
  return collapsed ? "expand" : "collapse";
}

function FolderMenuItems({
  surface,
  folder,
  scope,
}: {
  surface: MenuSurface;
  folder: SidebarFolder;
  scope: SidebarFolderScope;
}) {
  const { t } = useTranslation();
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const createInside = useCreateSidebarFolderAction(scope, folder.id);
  const move = useMoveToSidebarFolderAction({
    scope,
    entry: sidebarFolderEntry(folder.id),
    title: folder.name,
  });
  const remove = useRemoveSidebarFolder();
  const rename = useCallback(
    () => useSidebarFolderDialog.getState().open({ kind: "rename", folderId: folder.id }),
    [folder.id],
  );
  const removeFolder = useCallback(() => remove(folder.id, folder.name), [remove, folder]);
  return (
    <>
      {createInside ? (
        <Item
          leading={newFolderIcon}
          onSelect={createInside}
          testID={`sidebar-folder-menu-new-${folder.id}`}
        >
          {t("sidebar.folders.actions.newSubfolder")}
        </Item>
      ) : null}
      <Item
        leading={renameIcon}
        onSelect={rename}
        testID={`sidebar-folder-menu-rename-${folder.id}`}
      >
        {t("sidebar.folders.actions.rename")}
      </Item>
      {move ? (
        <Item leading={moveIcon} onSelect={move} testID={`sidebar-folder-menu-move-${folder.id}`}>
          {t("sidebar.folders.actions.moveToFolder")}
        </Item>
      ) : null}
      <Item
        leading={deleteIcon}
        onSelect={removeFolder}
        testID={`sidebar-folder-menu-delete-${folder.id}`}
      >
        {t("sidebar.folders.actions.delete")}
      </Item>
    </>
  );
}

/** A folder's ⋮ menu. */
function FolderKebabMenu({
  folder,
  scope,
  open,
  onOpenChange,
}: {
  folder: SidebarFolder;
  scope: SidebarFolderScope;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  // The project rows' kebab contract: a fixed, centered box, 44px on touch, so the glyph sits on
  // the row's centerline instead of the top of a box the touch rule enlarged.
  const actionSize = useSidebarActionSize();
  const style = useMemo(() => [sidebarTrailingActionStyles.kebab, actionSize], [actionSize]);
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        style={style}
        accessibilityRole="button"
        accessibilityLabel={t("sidebar.folders.actions.menu")}
        testID={`sidebar-folder-kebab-${folder.id}`}
      >
        {kebabIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} sheetTitle={t("sidebar.folders.actions.menu")}>
        <FolderMenuItems surface="dropdown" folder={folder} scope={scope} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The ⋮ menu of a focused folder, whose own row the focused view hides. */
export function SidebarFolderMenuButton({ folder }: { folder: SidebarFolder }) {
  return <FolderKebabMenu folder={folder} scope={folder.scope} />;
}

/**
 * A folder heading inside a sortable sidebar list. Pressing it folds the folder; dragging it
 * moves the folder with its contents; dropping a row onto it (web) moves the row inside.
 */
export function SidebarFolderRow({
  row,
  scope,
  level,
  drag,
  isDragging,
  dragHandleProps,
}: {
  row: SidebarFolderRowModel;
  scope: SidebarFolderScope;
  /** Hierarchy level, which sets the indent; see `sidebarIndent`. */
  level: number;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const density = useSidebarRowDensity();
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const interaction = useLongPressDragInteraction({ drag, menuController: null });
  const { folder, collapsed, itemCount } = row;
  const focusTarget = useMemo<SidebarFocusTarget>(
    () => ({ kind: "folder", folderId: folder.id }),
    [folder.id],
  );
  const rowFocus = useSidebarRowFocus({ target: focusTarget, isHovered });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};
  const toggle = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    if (rowFocus.isRoot) return;
    toggleSidebarFolderCollapsed(folder.id);
  }, [folder.id, interaction.didLongPressRef, rowFocus.isRoot]);
  const handlePointerEnter = useCallback(() => {
    if (!touch) setIsHovered(true);
  }, [touch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  // The fill is CSS hover so it clears when the row moves out from under a resting cursor. The
  // dragging fill must win, and `:hover` outranks it, so the hover entry steps aside while dragging.
  const rowStyle = useMemo(
    () => [
      sidebarContainerRowStyles.row,
      styles.rowGroup,
      density,
      sidebarIndentStyle(level),
      contextMenuOpen && sidebarContainerRowStyles.rowHovered,
      !isDragging && styles.rowHoverable,
      isDragging && styles.rowDragging,
    ],
    [density, level, contextMenuOpen, isDragging],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  // The kebab stays mounted and reveals through CSS while the row is hovered or focused.
  const alwaysShowActions = menuOpen || touch || compact || isNative;
  const countLabel = String(itemCount);

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        style={rowStyle}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <ContextMenuTrigger
          enabledOnMobile={false}
          accessibilityRole="button"
          accessibilityLabel={folder.name}
          accessibilityState={accessibilityState}
          style={sidebarContainerRowStyles.main}
          onPressIn={interaction.handlePressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={interaction.handlePressOut}
          onPress={toggle}
          testID={`sidebar-folder-row-${folder.id}`}
        >
          <SidebarLeadingSlot
            chevron={folderChevron(rowFocus.isRoot, collapsed)}
            cssHover
            testID={`sidebar-folder-leading-${folder.id}`}
          >
            <SidebarFolderIcon calm={!contextMenuOpen} cssHover />
          </SidebarLeadingSlot>
          <Text
            style={[
              sidebarContainerRowStyles.title,
              !contextMenuOpen && sidebarContainerRowStyles.calmTitle,
            ]}
            numberOfLines={1}
          >
            {folder.name}
          </Text>
          {collapsed ? (
            <SidebarCountBadge
              label={countLabel}
              accessibilityLabel={`${folder.name}: ${countLabel}`}
              testID={`sidebar-folder-count-${folder.id}`}
            />
          ) : null}
        </ContextMenuTrigger>
        <View
          style={[sidebarTrailingActionStyles.rail, touch && sidebarTrailingActionStyles.railTouch]}
        >
          {rowFocus.buttonAction ? (
            <SidebarFocusButton
              name={folder.name}
              onPress={rowFocus.buttonAction}
              testID={`sidebar-folder-focus-${folder.id}`}
            />
          ) : null}
          <View style={alwaysShowActions ? undefined : styles.kebabReveal}>
            <FolderKebabMenu
              folder={folder}
              scope={scope}
              open={menuOpen}
              onOpenChange={setMenuOpen}
            />
          </View>
        </View>
      </View>
      <ContextMenuContent align="start" width={220} testID={`sidebar-folder-context-${folder.id}`}>
        <FolderMenuItems surface="context" folder={folder} scope={scope} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    zIndex: 3,
    ...theme.shadow.md,
  },
  rowGroup: hoverGroup([FOLDER_ROW_HOVER_GROUP, SIDEBAR_LEADING_HOVER_GROUP]),
  // A calm title regains full strength while the row is hovered.
  rowHoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
  kebabReveal: revealOnGroupHover(FOLDER_ROW_HOVER_GROUP),
}));
