import { useCallback, useMemo, type ReactElement } from "react";
import type { GestureResponderEvent } from "react-native";
import { Pressable, Text, View } from "react-native";
import {
  ChevronDown,
  Copy,
  Eye,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { MENU_ITEM_HEIGHT } from "@/components/ui/menu/menu-geometry";
import { openServiceUrl } from "@/utils/open-service-url";
import type {
  WorkspaceScriptLinkKind,
  WorkspaceScriptLinkTarget,
} from "@/utils/workspace-script-links";
import type { Theme } from "@/styles/theme";
import { groupHoverStyle, hoverGroup, hoverStyle } from "@/styles/hover";
import { isWeb } from "@/constants/platform";

import { extraMutedIconColorMapping } from "@/components/ui/icon-color";
import { ExitCodeBadge, routeLabelKey, ScriptIcon } from "./script-marks";
import { scriptToneColorMapping } from "./script-status";
import {
  useWorkspaceScriptActions,
  type WorkspaceScriptActions,
} from "./use-workspace-script-actions";

type RowActionIcon = "copy" | "open" | "restart" | "start" | "stop" | "terminal";

interface WorkspaceScriptsButtonProps {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds?: readonly string[];
  onScriptTerminalStarted?: (terminalId: string) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
  hideLabels?: boolean;
  presentation?: "split" | "ghost" | "menu";
}

const ThemedPlay = withUnistyles(Play);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedEye = withUnistyles(Eye);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedSquare = withUnistyles(Square);

const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const playFillTransparent = { fill: "transparent" };

interface ScriptRowActionButtonProps {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: RowActionIcon;
  onPress: () => void;
  testID: string;
  tooltipLabel: string;
}

/**
 * Web icons inherit the button's CSS `color`, which follows `:hover`, so the tint clears when the
 * row moves out from under a resting cursor. Native has no hover and keeps the muted tint.
 */
const rowActionIconColor = isWeb ? { color: "currentColor" } : { uniProps: mutedColorMapping };

function RowActionIconElement({ icon }: { icon: RowActionIcon }): ReactElement {
  switch (icon) {
    case "copy":
      return <ThemedCopy size={11} {...rowActionIconColor} />;
    case "open":
      return <ThemedEye size={12} {...rowActionIconColor} />;
    case "restart":
      return <ThemedRotateCw size={11} {...rowActionIconColor} />;
    case "start":
      return <ThemedPlay size={11} {...rowActionIconColor} {...playFillTransparent} />;
    case "stop":
      return <ThemedSquare size={11} {...rowActionIconColor} />;
    case "terminal":
      return <ThemedSquareTerminal size={12} {...rowActionIconColor} />;
  }
}

function ScriptRowActionButton({
  accessibilityLabel,
  disabled,
  icon,
  onPress,
  testID,
  tooltipLabel,
}: ScriptRowActionButtonProps): ReactElement {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          hitSlop={6}
          disabled={disabled}
          onPress={handlePress}
          style={[
            styles.iconActionButton,
            disabled ? styles.iconActionButtonDisabled : styles.iconActionButtonHover,
          ]}
        >
          <RowActionIconElement icon={icon} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent testID={`${testID}-tooltip`} side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface ServiceLinkRowProps {
  selectedTarget: WorkspaceScriptLinkTarget;
  targets: WorkspaceScriptLinkTarget[];
  scriptName: string;
  onSelectKind: (kind: WorkspaceScriptLinkKind) => void;
  onCopy: (target: WorkspaceScriptLinkTarget) => void;
}

function ServiceRouteOption({
  scriptName,
  selectedKind,
  target,
  onSelect,
}: {
  scriptName: string;
  selectedKind: WorkspaceScriptLinkKind;
  target: WorkspaceScriptLinkTarget;
  onSelect: (kind: WorkspaceScriptLinkKind) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(target.kind), [onSelect, target.kind]);
  return (
    <DropdownMenuItem
      testID={`workspace-scripts-route-${scriptName}-${target.kind}`}
      selected={target.kind === selectedKind}
      showSelectedCheck
      description={target.label}
      onSelect={handleSelect}
    >
      {t(routeLabelKey(target.kind))}
    </DropdownMenuItem>
  );
}

/** The trigger is a CSS hover group; the chevron and label brighten while it is hovered. */
function ServiceRouteTriggerContent({ label }: { label: string }): ReactElement {
  return (
    <>
      <View style={[styles.routeSelectorButton, styles.routeSelectorChevronHover]}>
        <ThemedChevronDown size={14} {...rowActionIconColor} />
      </View>
      <Text style={[styles.hostLabel, styles.hostLabelHover]} numberOfLines={1}>
        {label}
      </Text>
    </>
  );
}

function ServiceRouteSelector({
  scriptName,
  selectedTarget,
  targets,
  onSelect,
}: {
  scriptName: string;
  selectedTarget: WorkspaceScriptLinkTarget;
  targets: WorkspaceScriptLinkTarget[];
  onSelect: (kind: WorkspaceScriptLinkKind) => void;
}): ReactElement {
  const { t } = useTranslation();
  const accessibilityLabel = t("workspace.scripts.accessibility.chooseUrl", { scriptName });

  return (
    <DropdownMenu>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <View collapsable={false} style={styles.routeSelectorFrame}>
            <DropdownMenuTrigger
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              testID={`workspace-scripts-route-${scriptName}`}
              hitSlop={6}
              style={styles.routeSelectorTrigger}
            >
              <ServiceRouteTriggerContent label={selectedTarget.label} />
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent
          testID={`workspace-scripts-route-${scriptName}-tooltip`}
          side="top"
          align="center"
          offset={8}
        >
          <Text style={styles.tooltipText}>{t("workspace.scripts.actions.chooseUrl")}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" minWidth={220} maxWidth={280}>
        {targets.map((target) => (
          <ServiceRouteOption
            key={target.kind}
            scriptName={scriptName}
            selectedKind={selectedTarget.kind}
            target={target}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ServiceLinkRow({
  selectedTarget,
  targets,
  scriptName,
  onSelectKind,
  onCopy,
}: ServiceLinkRowProps): ReactElement {
  const { t } = useTranslation();
  const closeMenu = useDropdownMenuClose();
  const { label } = selectedTarget;

  const handleCopy = useCallback(() => {
    closeMenu();
    onCopy(selectedTarget);
  }, [selectedTarget, onCopy, closeMenu]);

  return (
    <View style={styles.hostRow}>
      {targets.length > 1 ? (
        <ServiceRouteSelector
          scriptName={scriptName}
          selectedTarget={selectedTarget}
          targets={targets}
          onSelect={onSelectKind}
        />
      ) : (
        <View style={styles.routeDisplay}>
          <View style={styles.routeSelectorButton} />
          <Text style={styles.hostLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
      <ScriptRowActionButton
        accessibilityLabel={t("workspace.scripts.accessibility.copyUrl", { scriptName })}
        testID={`workspace-scripts-copy-${scriptName}`}
        icon="copy"
        onPress={handleCopy}
        tooltipLabel={t("workspace.scripts.actions.copyUrl")}
      />
    </View>
  );
}

interface ScriptRowProps {
  script: WorkspaceDescriptor["scripts"][number];
  liveTerminalIdSet: Set<string>;
  actions: WorkspaceScriptActions;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

function ScriptRow({
  script,
  liveTerminalIdSet,
  actions,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: ScriptRowProps): ReactElement {
  const { t } = useTranslation();
  const isRunning = script.lifecycle === "running";
  const exitCode = script.exitCode ?? null;
  const { selected: selectedLink, targets: linkTargets } = actions.resolveLinks(script);
  const liveTerminalId =
    script.terminalId && liveTerminalIdSet.has(script.terminalId) ? script.terminalId : null;
  const showExitBadge = !isRunning && exitCode !== null;
  const { start, stop, restart } = actions;
  const closeMenu = useDropdownMenuClose();

  const handleOpenService = useCallback(() => {
    if (!selectedLink) return;
    closeMenu();
    void openServiceUrl(selectedLink.url, { openInApp: onOpenUrlInBrowserTab });
  }, [selectedLink, closeMenu, onOpenUrlInBrowserTab]);

  const handleView = useCallback(() => {
    if (liveTerminalId) onViewTerminal?.(liveTerminalId);
  }, [liveTerminalId, onViewTerminal]);

  const handleRun = useCallback(() => {
    start(script.scriptName);
  }, [start, script.scriptName]);

  const handleStop = useCallback(() => {
    stop(script.scriptName);
  }, [stop, script.scriptName]);

  const handleRestart = useCallback(() => {
    restart(script.scriptName);
  }, [restart, script.scriptName]);

  const scriptNameStyle = useMemo(
    () => (isRunning ? [styles.scriptName, styles.scriptNameActive] : styles.scriptName),
    [isRunning],
  );

  const viewAction =
    isRunning && liveTerminalId ? (
      <ScriptRowActionButton
        accessibilityLabel={t("workspace.scripts.accessibility.viewTerminal", {
          scriptName: script.scriptName,
        })}
        testID={`workspace-scripts-view-${script.scriptName}`}
        icon="terminal"
        onPress={handleView}
        tooltipLabel={t("workspace.scripts.actions.view")}
      />
    ) : null;

  const openServiceAction = selectedLink ? (
    <ScriptRowActionButton
      accessibilityLabel={t("workspace.scripts.accessibility.openService", {
        scriptName: script.scriptName,
      })}
      testID={`workspace-scripts-open-${script.scriptName}`}
      icon="open"
      onPress={handleOpenService}
      tooltipLabel={t("workspace.scripts.actions.openService")}
    />
  ) : null;

  const lifecycleAction = isRunning ? (
    <ScriptRowActionButton
      accessibilityLabel={t("workspace.scripts.accessibility.stopScript", {
        scriptName: script.scriptName,
      })}
      testID={`workspace-scripts-stop-${script.scriptName}`}
      disabled={actions.isStopPending}
      icon="stop"
      onPress={handleStop}
      tooltipLabel={t("workspace.scripts.actions.stop")}
    />
  ) : (
    <ScriptRowActionButton
      accessibilityLabel={t("workspace.scripts.accessibility.runScript", {
        scriptName: script.scriptName,
      })}
      testID={`workspace-scripts-start-${script.scriptName}`}
      disabled={actions.isStartPending}
      icon="start"
      onPress={handleRun}
      tooltipLabel={t("workspace.scripts.actions.run")}
    />
  );

  return (
    <View
      testID={`workspace-scripts-item-${script.scriptName}`}
      accessibilityLabel={t("workspace.scripts.accessibility.script", {
        scriptName: script.scriptName,
      })}
    >
      <View style={styles.scriptHeader}>
        <ScriptIcon script={script} size={14} />
        <Text style={scriptNameStyle} numberOfLines={1}>
          {script.scriptName}
        </Text>
        {showExitBadge ? <ExitCodeBadge code={exitCode} /> : null}
        <View style={styles.spacer} />
        {openServiceAction}
        {viewAction}
        {isRunning ? (
          <ScriptRowActionButton
            accessibilityLabel={t("workspace.scripts.accessibility.restartScript", {
              scriptName: script.scriptName,
            })}
            testID={`workspace-scripts-restart-${script.scriptName}`}
            disabled={actions.isStopPending}
            icon="restart"
            onPress={handleRestart}
            tooltipLabel={t("workspace.scripts.actions.restart")}
          />
        ) : null}
        {lifecycleAction}
      </View>
      {selectedLink ? (
        <View style={styles.hostList}>
          <ServiceLinkRow
            selectedTarget={selectedLink}
            targets={linkTargets}
            scriptName={script.scriptName}
            onSelectKind={actions.selectRoute}
            onCopy={actions.copyUrl}
          />
        </View>
      ) : null}
    </View>
  );
}

function SingleScriptButton({
  script,
  actions,
  liveTerminalIdSet,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: Pick<
  ScriptRowProps,
  "script" | "actions" | "liveTerminalIdSet" | "onViewTerminal" | "onOpenUrlInBrowserTab"
>) {
  const { t } = useTranslation();
  const running = script.lifecycle === "running";
  const link = actions.resolveLinks(script).selected;
  const terminalId =
    script.terminalId && liveTerminalIdSet.has(script.terminalId) ? script.terminalId : null;
  let labelKey = "workspace.scripts.accessibility.runScript" as
    | "workspace.scripts.accessibility.runScript"
    | "workspace.scripts.accessibility.openService"
    | "workspace.scripts.accessibility.viewTerminal";
  if (running)
    labelKey = link
      ? "workspace.scripts.accessibility.openService"
      : "workspace.scripts.accessibility.viewTerminal";
  const label = t(labelKey, { scriptName: script.scriptName });
  const handlePress = useCallback(() => {
    if (!running) actions.start(script.scriptName);
    else if (link) void openServiceUrl(link.url, { openInApp: onOpenUrlInBrowserTab });
    else if (terminalId) onViewTerminal?.(terminalId);
  }, [
    running,
    script.scriptName,
    link,
    terminalId,
    onOpenUrlInBrowserTab,
    onViewTerminal,
    actions,
  ]);
  return (
    <Tooltip enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <Button
          testID="workspace-scripts-button"
          variant="ghost"
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={actions.isStartPending || (running && !link && !terminalId)}
          onPress={handlePress}
          style={styles.singleButton}
        >
          <ThemedPlay
            size={18}
            uniProps={scriptToneColorMapping(running ? "running" : "idle")}
            {...playFillTransparent}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceScriptsButton({
  serverId,
  workspaceId,
  scripts,
  liveTerminalIds = [],
  onScriptTerminalStarted,
  onViewTerminal,
  onOpenUrlInBrowserTab,
  hideLabels,
  presentation = "split",
}: WorkspaceScriptsButtonProps): ReactElement | null {
  const { t } = useTranslation();
  const actions = useWorkspaceScriptActions({
    serverId,
    workspaceId,
    scripts,
    onScriptTerminalStarted,
  });
  const liveTerminalIdSet = useMemo(() => new Set(liveTerminalIds), [liveTerminalIds]);

  const triggerStyle = useCallback(
    ({ pressed, open }: { pressed: boolean; open: boolean }) => [
      styles.splitButtonPrimary,
      (pressed || open) && styles.splitButtonPrimaryHovered,
    ],
    [],
  );

  if (scripts.length === 0) {
    return null;
  }

  // The trigger only says whether anything runs; health is for the rows inside.
  const hasAnyRunning = scripts.some((s) => s.lifecycle === "running");
  const triggerPlayMapping = scriptToneColorMapping(hasAnyRunning ? "running" : "idle");

  const scriptRows = (
    <>
      {scripts.map((script) => (
        <ScriptRow
          key={script.scriptName}
          script={script}
          liveTerminalIdSet={liveTerminalIdSet}
          actions={actions}
          onViewTerminal={onViewTerminal}
          onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
        />
      ))}
    </>
  );
  if (presentation === "menu") return scriptRows;
  if (scripts.length === 1 && presentation === "split")
    return (
      <SingleScriptButton
        script={scripts[0]}
        actions={actions}
        liveTerminalIdSet={liveTerminalIdSet}
        onViewTerminal={onViewTerminal}
        onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
      />
    );

  return (
    <View style={styles.row}>
      <View style={styles.splitButton}>
        <DropdownMenu>
          <DropdownMenuTrigger
            testID="workspace-scripts-button"
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.scripts.accessibility.trigger")}
          >
            <View style={styles.splitButtonContent}>
              <ThemedPlay size={14} uniProps={triggerPlayMapping} {...playFillTransparent} />
              {!hideLabels && presentation !== "ghost" && (
                <Text style={styles.splitButtonText}>{t("workspace.scripts.title")}</Text>
              )}
              {presentation !== "ghost" ? (
                <ThemedChevronDown size={16} uniProps={extraMutedIconColorMapping} />
              ) : null}
            </View>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            minWidth={200}
            maxWidth={280}
            testID="workspace-scripts-menu"
          >
            {scriptRows}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  singleButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  splitButton: {
    height: 40,
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: 16,
    overflow: "hidden",
  },
  splitButtonPrimary: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    justifyContent: "center",
    ...hoverStyle({ backgroundColor: theme.colors.surface2 }),
  },
  splitButtonPrimaryHovered: {
    backgroundColor: theme.colors.surface2,
  },
  splitButtonText: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  splitButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: {
      xs: theme.spacing[1.5],
      md: theme.spacing[1],
    },
    minHeight: theme.fontSize.base * 1.5,
  },
  scriptHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    minHeight: MENU_ITEM_HEIGHT,
  },
  scriptName: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 18,
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
  },
  scriptNameActive: {
    color: theme.colors.foreground,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  hostList: {
    marginTop: 2,
    paddingHorizontal: theme.spacing[3],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 2,
    minHeight: 18,
  },
  routeDisplay: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hostLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
  hostLabelActive: {
    color: theme.colors.foreground,
  },
  iconActionButton: {
    padding: 2,
  },
  // Disabled buttons never reported hover, so they keep the muted tint.
  iconActionButtonHover: hoverStyle(
    { color: theme.colors.foreground },
    { color: theme.colors.foregroundMuted },
  ),
  iconActionButtonDisabled: { _web: { color: theme.colors.foregroundMuted } },
  routeSelectorChevronHover: groupHoverStyle(
    "script-route",
    { color: theme.colors.foreground },
    { color: theme.colors.foregroundMuted },
  ),
  hostLabelHover: groupHoverStyle("script-route", { color: theme.colors.foreground }),
  routeSelectorButton: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  routeSelectorFrame: {
    flex: 1,
    minWidth: 0,
  },
  routeSelectorTrigger: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,

    ...hoverGroup("script-route"),
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
