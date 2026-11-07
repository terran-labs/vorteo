import { useCallback, type ReactElement } from "react";
import { View, Pressable, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Factory, LockKeyhole, Repeat2, CirclePause } from "lucide-react-native";
import { router } from "expo-router";
import { useVortonTouch } from "@/vorton-touch";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipText } from "@/components/ui/tooltip";
import { useWorkspaceScheduleState } from "./scheduled";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import { FACTORY_MANAGED_EXPLANATION, useFactoryMembership } from "./factory-membership";
import { SYSTEM_MANAGED_EXPLANATION, useSystemManaged } from "./system-membership";
import { litToneColor, useSidebarRowTone } from "@/components/sidebar/row-tone";
import { SIDEBAR_TRAILING_ICON_SLOT } from "@/components/sidebar/trailing-icon-slot";

const Shield = withUnistyles(LockKeyhole);
const Repeat = withUnistyles(Repeat2);
const Paused = withUnistyles(CirclePause);
const FactoryIcon = withUnistyles(Factory);
const neutral = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});

/** In a lit sidebar row the marks take the title's color; elsewhere they stay quiet. */
function useMarkColor() {
  return useSidebarRowTone() === "lit" ? litToneColor : neutral;
}
function FactoryIndicator({ workspaceId }: { workspaceId: string }) {
  const markColor = useMarkColor();
  return (
    <IndicatorTooltip label={FACTORY_MANAGED_EXPLANATION}>
      <View
        tabIndex={0}
        style={styles.badgeSlot}
        accessible
        accessibilityLabel={FACTORY_MANAGED_EXPLANATION}
        testID={`workspace-factory-${workspaceId}`}
      >
        <FactoryIcon size={16} uniProps={markColor} />
      </View>
    </IndicatorTooltip>
  );
}

export function WorkspaceLifecycleIndicators({
  workspace,
  hideFactory = false,
}: {
  workspace: SidebarWorkspaceEntry;
  hideFactory?: boolean;
}) {
  const touch = useVortonTouch();
  const markColor = useMarkColor();
  const scheduled = useWorkspaceScheduleState(workspace.serverId, workspace.workspaceId);
  const membership = useFactoryMembership(workspace.serverId, workspace.workspaceId);
  const factory = Boolean(membership);
  const systemManaged = useSystemManaged(workspace.serverId, workspace.workspaceId);
  const protectedLabel = systemManaged ? SYSTEM_MANAGED_EXPLANATION : "Protected";
  const locked = workspace.protected || (factory && hideFactory);
  const label = scheduled === "paused" ? "Paused" : "Scheduled";
  const openSchedules = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      router.push({
        pathname: "/schedules",
        params: {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
        },
      });
    },
    [workspace.serverId, workspace.workspaceId],
  );
  if (!scheduled && !workspace.protected && !factory) return null;
  return (
    <>
      {locked ? (
        <IndicatorTooltip label={protectedLabel}>
          <View
            style={styles.badgeSlot}
            accessible
            accessibilityLabel={systemManaged ? SYSTEM_MANAGED_EXPLANATION : "Protected workspace"}
            testID={`workspace-shield-${workspace.workspaceId}`}
            tabIndex={0}
          >
            <Shield size={16} uniProps={markColor} />
          </View>
        </IndicatorTooltip>
      ) : null}
      {factory && !hideFactory ? <FactoryIndicator workspaceId={workspace.workspaceId} /> : null}
      {scheduled ? (
        <IndicatorTooltip label={label}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} workspace. Open schedules`}
            style={[styles.badgeSlot, touch && styles.touchTarget]}
            testID={`workspace-scheduled-${workspace.workspaceId}`}
            onPress={openSchedules}
          >
            {scheduled === "paused" ? (
              <Paused size={16} uniProps={markColor} />
            ) : (
              <Repeat size={16} uniProps={markColor} />
            )}
          </Pressable>
        </IndicatorTooltip>
      ) : null}
    </>
  );
}
function IndicatorTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        <TooltipText label={label} />
      </TooltipContent>
    </Tooltip>
  );
}
const styles = StyleSheet.create({
  // A fixed column, the same width as every other sidebar trailing icon, so locks and schedule
  // marks line up row to row whatever follows them.
  badgeSlot: {
    width: SIDEBAR_TRAILING_ICON_SLOT,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  // Keep the visual badge compact inside a full-height touch target.
  touchTarget: { minHeight: 44, justifyContent: "center" },
});
