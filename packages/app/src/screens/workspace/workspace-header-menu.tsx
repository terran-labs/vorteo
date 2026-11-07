import { usePluginWorkspaceMenu } from "@/plugins";
import { WorkspaceMenuItems } from "@/components/sidebar/sidebar-workspace-menu";
import { WorkspaceRenameModal } from "@/components/workspace-rename-modal";
import { createSidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { useSidebarWorkspacePinController } from "@/hooks/use-sidebar-workspace-pin";
import { useHostFeature } from "@/runtime/host-features";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useWorkspaceMenuActions } from "@/workspace/use-workspace-menu-actions";
import { useWorkspaceSessionMenu } from "@/workspace/use-workspace-session-menu";
import { useWorkspaceLabelMenuPages } from "@/workspace-labels/picker";
import React, { createContext, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { EllipsisVertical, Globe, SquarePen } from "lucide-react-native";

import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
  useIconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { TerminalProfileIcon } from "@/components/terminal-profile-icon";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";
import type { MenuPageDefinition } from "@/components/ui/dropdown-menu";
import {
  useWorkspaceScriptsMenuPages,
  type UseWorkspaceScriptsMenuPagesInput,
} from "@/screens/workspace/scripts";

export const WorkspaceToolbarToggleContext = createContext<ReactNode>(null);

export const WorkspaceOverflowItemsContext = createContext<{
  items: ReactNode;
  extraItems?: ReactNode;
  pages: ReturnType<typeof useWorkspaceLabelMenuPages>;
} | null>(null);

interface WorkspaceMenuPresentation {
  children?: ReactNode;
  extraItems?: ReactNode;
  /** Rows that lead the menu, ahead of plugin rows and the workspace actions. */
  leadingItems?: ReactNode;
  /** Pages those leading rows open, alongside the label and plugin pages. */
  extraPages?: readonly MenuPageDefinition[];
  /** Something inside the menu needs looking at, so the trigger carries a dot. */
  needsAttention?: boolean;
  includeCompactPluginButtons?: boolean;
  overflow?: boolean;
  enabled?: boolean;
}

/** Share actions and submenu pages with the existing pane menu, without another trigger. */
export function WorkspaceOverflowProvider(
  props: WorkspaceHeaderWorkspaceActions & WorkspaceMenuPresentation,
) {
  return <WorkspaceHeaderActionsMenu {...props} overflow />;
}

const ThemedEllipsis = withUnistyles(EllipsisVertical);
const ThemedSquarePen = withUnistyles(SquarePen);

const ThemedGlobe = withUnistyles(Globe);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MENU_NEW_BROWSER_ICON = <ThemedGlobe size={16} uniProps={mutedColorMapping} />;
const MENU_NEW_AGENT_ICON = <ThemedSquarePen size={16} uniProps={mutedColorMapping} />;
const MENU_NEW_TERMINAL_ICON = <TerminalProfileIcon iconKey={undefined} size={16} />;

function WorkspaceHeaderMenuTriggerIcon() {
  return (
    <ThemedEllipsis
      size={iconButtonChromeGlyphSize("large")}
      uniProps={extraMutedIconColorMapping}
    />
  );
}

/** The ⋯ with a dot on it, for when something inside the menu needs looking at. */
function WorkspaceHeaderMenuAttentionTriggerIcon() {
  return (
    <View>
      <WorkspaceHeaderMenuTriggerIcon />
      <View style={styles.attentionDot} testID="workspace-header-menu-attention" />
    </View>
  );
}

/**
 * The compact header buttons draw at 32pt, under the 44pt touch minimum, and sit flush against
 * each other — so the slop can only grow vertically. Widening it would put two buttons' slop over
 * the same pixels, which is a worse miss than a small target.
 */
const COMPACT_HEADER_BUTTON_HIT_SLOP = { top: 8, bottom: 8 } as const;

export interface WorkspaceHeaderWorkspaceActions {
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}

function WorkspaceHeaderActionsMenu({
  normalizedServerId,
  normalizedWorkspaceId,
  children,
  extraItems,
  leadingItems,
  extraPages,
  needsAttention,
  includeCompactPluginButtons = false,
  overflow = false,
  enabled = true,
}: WorkspaceHeaderWorkspaceActions & WorkspaceMenuPresentation) {
  const descriptor = useWorkspace(normalizedServerId, normalizedWorkspaceId);
  const workspace = useMemo(
    () =>
      descriptor
        ? createSidebarWorkspaceEntry({ serverId: normalizedServerId, workspace: descriptor })
        : null,
    [descriptor, normalizedServerId],
  );
  if (!workspace)
    return overflow ? (
      <WorkspaceOverflowItemsContext.Provider value={null}>
        {children}
      </WorkspaceOverflowItemsContext.Provider>
    ) : null;
  return (
    <WorkspaceHeaderActionsMenuLoaded
      workspace={workspace}
      overflow={overflow}
      enabled={enabled}
      extraItems={extraItems}
      leadingItems={leadingItems}
      extraPages={extraPages}
      needsAttention={needsAttention}
      includeCompactPluginButtons={includeCompactPluginButtons}
    >
      {children}
    </WorkspaceHeaderActionsMenuLoaded>
  );
}

function WorkspaceHeaderActionsMenuLoaded({
  workspace,
  children,
  extraItems,
  leadingItems,
  extraPages,
  needsAttention = false,
  includeCompactPluginButtons,
  overflow,
  enabled,
}: WorkspaceMenuPresentation & {
  workspace: SidebarWorkspaceEntry;
}) {
  const { t } = useTranslation();
  const canPin = useHostFeature(workspace.serverId, "workspacePinning");
  const onToggleWorkspacePin = useSidebarWorkspacePinController();
  const actions = useWorkspaceMenuActions({
    workspace,
    selected: true,
    canPin,
    onToggleWorkspacePin,
  });
  const sessionMenu = useWorkspaceSessionMenu(workspace.serverId, workspace.workspaceId);
  const target = useMemo(
    () => ({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      labels: workspace.labels ?? [],
    }),
    [workspace.serverId, workspace.workspaceId, workspace.labels],
  );
  const labelPages = useWorkspaceLabelMenuPages(target);
  const pluginMenu = usePluginWorkspaceMenu(workspace.serverId, workspace.workspaceId);
  const pages = useMemo(
    () => [
      ...(extraPages ?? []),
      ...labelPages,
      ...(includeCompactPluginButtons ? pluginMenu.pages : []),
    ],
    [extraPages, includeCompactPluginButtons, labelPages, pluginMenu.pages],
  );
  const items = useMemo(
    () => (
      <WorkspaceMenuItems
        surface="dropdown"
        testIDPrefix="workspace-header"
        workspaceKey={workspace.workspaceKey}
        serverId={workspace.serverId}
        workspaceId={workspace.workspaceId}
        onCopyPath={actions.handleCopyPath}
        onCopyBranchName={
          workspace.projectKind === "git" ? actions.handleCopyBranchName : undefined
        }
        onRename={actions.handleOpenRename}
        onMarkAsRead={actions.hasClearableAttention ? actions.handleMarkAsRead : undefined}
        onMarkAsUnread={actions.canMarkUnread ? actions.handleMarkAsUnread : undefined}
        onArchive={actions.handleArchive}
        archiveStatus={actions.isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        archiveShortcutKeys={actions.archiveShortcutKeys}
        isPinned={actions.isPinned}
        onTogglePin={actions.onTogglePin}
        openInFileManagerPath={workspace.workspaceDirectory}
        {...sessionMenu}
      />
    ),
    [actions, sessionMenu, t, workspace],
  );
  const sheets = (
    <>
      <WorkspaceRenameModal
        visible={actions.isRenameOpen}
        workspace={workspace}
        onClose={actions.handleCloseRename}
        testID="workspace-header-rename-modal"
      />
      {sessionMenu.sheet}
    </>
  );
  const overflowValue = useMemo(
    () => (enabled ? { items, pages, extraItems } : null),
    [enabled, items, pages, extraItems],
  );
  if (overflow) {
    return (
      <WorkspaceOverflowItemsContext.Provider value={overflowValue}>
        {children}
        {sheets}
      </WorkspaceOverflowItemsContext.Provider>
    );
  }
  return (
    <>
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          testID="workspace-header-menu-trigger"
          style={workspaceHeaderMenuButtonStyle}
          hitSlop={COMPACT_HEADER_BUTTON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={
            needsAttention
              ? t("workspace.header.actions.workspaceActionsUnhealthy")
              : t("workspace.header.actions.workspaceActions")
          }
        >
          {needsAttention ? (
            <WorkspaceHeaderMenuAttentionTriggerIcon />
          ) : (
            <WorkspaceHeaderMenuTriggerIcon />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          width={260}
          testID="workspace-header-menu"
          pages={pages}
          sheetTitle={t("workspace.header.actions.workspaceActions")}
        >
          {leadingItems}
          {includeCompactPluginButtons && pluginMenu.rows.length > 0 ? (
            <>
              {pluginMenu.rows}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {items}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      {sheets}
    </>
  );
}

const workspaceMenuTarget = { minWidth: 40, minHeight: 40 };

/** The chrome's hover is CSS `:hover`, so only press and open state feed it. */
function workspaceHeaderMenuButtonStyle({ pressed, open }: { pressed: boolean; open: boolean }) {
  return [iconButtonChromeStyle({ size: "large", state: { pressed, open } }), workspaceMenuTarget];
}

/**
 * Wide layouts make tabs from the tab strip's `+` menu, so this one carries workspace actions only.
 */
export function WorkspaceHeaderMenuDesktop(
  props: WorkspaceHeaderWorkspaceActions & { children?: ReactNode },
) {
  return <WorkspaceHeaderActionsMenu {...props} />;
}

interface HeaderMenuProfileItemProps {
  profile: TerminalProfile;
  disabled: boolean;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
}

function HeaderMenuProfileItem({
  profile,
  disabled,
  onCreateTerminalWithProfile,
}: HeaderMenuProfileItemProps) {
  const handleSelect = useCallback(() => {
    onCreateTerminalWithProfile(profile);
  }, [onCreateTerminalWithProfile, profile]);

  const leading = useMemo(
    () => (
      <View style={styles.headerMenuProfileIconWrapper}>
        <TerminalProfileIcon iconKey={getTerminalProfileIcon(profile)} size={16} />
      </View>
    ),
    [profile],
  );

  return (
    <DropdownMenuItem leading={leading} disabled={disabled} onSelect={handleSelect}>
      {profile.name}
    </DropdownMenuItem>
  );
}

export interface WorkspaceHeaderMenuMobileProps extends WorkspaceHeaderWorkspaceActions {
  children?: ReactNode;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  scripts: UseWorkspaceScriptsMenuPagesInput;
  showCreateBrowserTab: boolean;
  createTerminalDisabled: boolean;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
  onCreateTerminal: () => void;
  onCreateDraftTab: () => void;
  onCreateBrowser: () => void;
}

/**
 * Compact layouts have no tab strip. New agent and New terminal sit in the tab switcher's footer;
 * the rarer launches stay here alongside the workspace actions.
 *
 * The header has no room for a scripts button either, so scripts are a page of this menu, and the
 * ⋯ carries a dot while a running service is unhealthy. Plugin header buttons are rows here for the
 * same reason.
 */
export function WorkspaceHeaderMenuMobile({
  normalizedServerId,
  normalizedWorkspaceId,
  scripts,
  showCreateBrowserTab,
  createTerminalDisabled,
  onCreateTerminalWithProfile,
  onCreateTerminal,
  onCreateDraftTab,
  onCreateBrowser,
  children,
}: WorkspaceHeaderMenuMobileProps) {
  const { t } = useTranslation();
  const router = useRouter();
  useIconButtonChromeStyle({ size: "large" });
  const { config } = useDaemonConfig(normalizedServerId);
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );

  const handleEditProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(normalizedServerId, "terminals") as Href);
  }, [normalizedServerId, router]);
  // The menu owns the script actions, so a restart started from a page outlives the sheet.
  const scriptsMenu = useWorkspaceScriptsMenuPages(scripts);

  return (
    <WorkspaceHeaderActionsMenu
      normalizedServerId={normalizedServerId}
      normalizedWorkspaceId={normalizedWorkspaceId}
      leadingItems={scriptsMenu.trigger}
      extraPages={scriptsMenu.pages}
      needsAttention={scriptsMenu.needsAttention}
      includeCompactPluginButtons
    >
      {children}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        testID="workspace-header-new-agent"
        leading={MENU_NEW_AGENT_ICON}
        onSelect={onCreateDraftTab}
      >
        {t("workspace.header.actions.newAgent")}
      </DropdownMenuItem>
      {showCreateBrowserTab ? (
        <DropdownMenuItem
          testID="workspace-header-new-browser"
          leading={MENU_NEW_BROWSER_ICON}
          onSelect={onCreateBrowser}
        >
          {t("workspace.header.actions.newBrowser")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t("workspace.tabs.actions.terminalProfilesMenu")}</DropdownMenuLabel>
      <DropdownMenuItem
        testID="workspace-header-new-terminal"
        leading={MENU_NEW_TERMINAL_ICON}
        disabled={createTerminalDisabled}
        onSelect={onCreateTerminal}
      >
        {t("workspace.header.actions.newTerminal")}
      </DropdownMenuItem>
      {profiles.map((profile) => (
        <HeaderMenuProfileItem
          key={profile.id}
          profile={profile}
          disabled={createTerminalDisabled}
          onCreateTerminalWithProfile={onCreateTerminalWithProfile}
        />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        testID="workspace-header-edit-terminal-profiles"
        onSelect={handleEditProfiles}
      >
        {t("workspace.tabs.actions.editTerminalProfiles")}
      </DropdownMenuItem>
    </WorkspaceHeaderActionsMenu>
  );
}

const ATTENTION_DOT_SIZE = 6;

const styles = StyleSheet.create((theme) => ({
  headerMenuProfileIconWrapper: {
    width: 16,
    height: 16,
  },
  // Same red as the Scripts row's unhealthy ▶, so the dot and the row it leads to agree.
  attentionDot: {
    position: "absolute",
    top: -1,
    right: -2,
    width: ATTENTION_DOT_SIZE,
    height: ATTENTION_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[500],
  },
}));
