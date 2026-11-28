import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Text, View, type StyleProp, type TextStyle } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Wrench } from "lucide-react-native";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { useFooterLeadingRule } from "@/components/sidebar/footer-rules";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requestSettingsJump } from "@/screens/settings/settings-jump";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  maintenanceProgress,
  messageHold,
  type MaintenanceOperation,
  type MaintenanceProgress,
  type MaintenanceTarget,
} from "./maintenance-progress";
import { useInstallationSystemModel } from "./panel";
import { readExecutionInstallation } from "./policy";

/**
 * Running installation maintenance, shown the same way everywhere (#720): one sidebar row, one
 * phone entry, the Host and Dev rows in Settings > System, Health and the composer. All read
 * `useMaintenanceProgress`, which reads the installation session the app already polls.
 */

const MaintenanceIcon = withUnistyles(Wrench);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// The installation polls every 5 seconds; re-reading staleness slightly slower is enough.
const STALE_CHECK_MS = 5_000;

const noSubscription = () => () => {};
const noState = () => null;

/** The live maintenance snapshot, or null where this app has no installation. */
export function useMaintenanceProgress(): MaintenanceProgress | null {
  const model = useInstallationSystemModel();
  const state = useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    model?.getState ?? noState,
    model?.getState ?? noState,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state) return;
    const timer = setInterval(() => setNow(Date.now()), STALE_CHECK_MS);
    return () => clearInterval(timer);
  }, [state]);
  return useMemo(() => {
    if (!state) return null;
    const servers = targetServers();
    return maintenanceProgress({
      unlocked: state.unlocked,
      jobs: state.jobs,
      serviceJobs: state.serviceQueue?.jobs ?? [],
      summary: state.restartSummary,
      lastUpdatedAt: state.lastUpdatedAt,
      now,
      // Only a thread this app lists for that daemon is named; others stay anonymous.
      visibleThread: (target, agentId) => {
        const serverId = servers[target];
        if (!serverId) return null;
        const agent = useSessionStore.getState().sessions[serverId]?.agents?.get(agentId);
        return agent ? (agent.title ?? null) : null;
      },
    });
  }, [now, state]);
}

/** Each daemon's server id, from the installation the app was served with. */
function targetServers(): Partial<Record<"host" | "dev", string>> {
  const environments = readExecutionInstallation()?.environments ?? [];
  const servers: Partial<Record<"host" | "dev", string>> = {};
  for (const environment of environments) {
    servers[environment.kind === "host" ? "host" : "dev"] = environment.serverId;
  }
  return servers;
}

/** Which daemon a server id belongs to, for the composer's hold check. */
export function serverTarget(serverId: string): "host" | "dev" | null {
  const servers = targetServers();
  if (servers.host === serverId) return "host";
  if (servers.dev === serverId) return "dev";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Words. Plain English, shared by every surface, as the rest of Settings > System is written.
// ---------------------------------------------------------------------------------------------

const TARGET_NAMES: Record<MaintenanceTarget, string> = {
  host: "Host",
  dev: "Dev",
  system: "System services",
};

export function operationName(operation: MaintenanceOperation): string {
  const target = TARGET_NAMES[operation.target];
  if (operation.kind === "update") return `${target} update`;
  if (operation.kind === "restart") return `${target} restart`;
  return `${target} maintenance`;
}

/** What the operation is doing now, from its tracked step. */
export function phaseLine(operation: MaintenanceOperation): string {
  switch (operation.phase) {
    case "preparing":
      return "Preparing; it will start automatically";
    case "starting":
      return "Waiting to start";
    case "preparing-update":
      return "Preparing the update";
    case "waiting-for-idle":
      return "Waiting for agents to go idle";
    case "holding-turns": {
      const count = operation.blockers.length;
      if (count === 0) return "Waiting for current turns to finish";
      return `Waiting for ${count} ${count === 1 ? "turn" : "turns"} to finish`;
    }
    case "installing":
      return "Installing the update and restarting";
    case "restarting":
      return "Restarting";
    case "checking":
      return "Checking the result";
    case "running":
      return "Running";
    case "other":
      return operation.stepText ?? "Running";
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Time since the operation began, saying what moment the timer counts from. */
export function sinceLine(operation: MaintenanceOperation, now: number): string {
  const elapsed = formatDuration(now - Date.parse(operation.since.at));
  if (operation.since.from === "started") return `${elapsed} so far`;
  if (operation.since.from === "approved") return `${elapsed} since approved`;
  return `${elapsed} since requested`;
}

/** Time in the current step; null when the coordinator does not report steps. */
export function stepLine(operation: MaintenanceOperation, now: number): string | null {
  if (!operation.stepSince) return null;
  return `${formatDuration(now - Date.parse(operation.stepSince))} in this step`;
}

/** The usual duration, or the plain statement that there is none. Never a deadline. */
export function estimateLine(operation: MaintenanceOperation): string {
  const estimate = operation.estimate;
  if (!estimate) return "No estimate available";
  return `Usually about ${formatDuration(estimate.medianMs)} (${formatDuration(estimate.minMs)} to ${formatDuration(estimate.maxMs)} over the last ${estimate.samples})`;
}

/** The threads a turn hold waits for, by title where the owner can open them. */
export function blockersLine(operation: MaintenanceOperation): string | null {
  if (operation.blockers.length === 0) return null;
  const named = operation.blockers.flatMap((blocker) => (blocker.title ? [blocker.title] : []));
  const others = operation.blockers.length - named.length;
  const parts = [...named];
  if (others > 0) parts.push(`${others} other ${others === 1 ? "thread" : "threads"}`);
  return `Waiting for: ${parts.join(", ")}`;
}

export function holdLine(operation: MaintenanceOperation): string | null {
  if (!operation.holdsMessages) return null;
  return `New messages to ${TARGET_NAMES[operation.target]} are held until it finishes.`;
}

export function overdueLine(operation: MaintenanceOperation): string | null {
  if (!operation.overdue) return null;
  const notice =
    operation.requesterNotice === "pending-release"
      ? " Requester not yet notified; will be told at release."
      : "";
  return `Past its deadline; it needs your decision.${notice}`;
}

function staleLine(progress: MaintenanceProgress): string | null {
  if (!progress.staleSince) return null;
  const at = new Date(progress.staleSince).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Status not updated since ${at}`;
}

const LOCKED_TITLE = "Maintenance is running";
const LOCKED_DETAIL = "Unlock System settings to see what it is doing.";

/** The one-line summary the sidebar row and the phone entry show. */
function summary(progress: MaintenanceProgress, now: number): { title: string; detail: string } {
  if (progress.locked) return { title: LOCKED_TITLE, detail: LOCKED_DETAIL };
  const [first] = progress.operations;
  const stale = staleLine(progress);
  if (progress.operations.length > 1) {
    // Names first, so a narrow phone line still says what is running; the oldest sets the time.
    const holding = progress.operations.some((operation) => operation.holdsMessages);
    const oldest = progress.operations.reduce((left, right) =>
      Date.parse(right.since.at) < Date.parse(left.since.at) ? right : left,
    );
    const details = [holding ? "messages held" : null, sinceLine(oldest, now), stale];
    return {
      title: progress.operations.map(operationName).join(", "),
      detail: details.filter(Boolean).join(" · "),
    };
  }
  const details = [sinceLine(first!, now), first!.holdsMessages ? "messages held" : null, stale];
  return {
    title: `${operationName(first!)}: ${phaseLine(first!)}`,
    detail: details.filter(Boolean).join(" · "),
  };
}

/** A one-second clock for elapsed times, running only while something is shown. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function hasMaintenance(progress: MaintenanceProgress | null): progress is MaintenanceProgress {
  return Boolean(progress && (progress.locked || progress.operations.length > 0));
}

/** The System page anchor for a target's row; System services share the page's top. */
export function maintenanceAnchorId(target: MaintenanceTarget): string {
  return target === "system" ? "settings-system-services" : `settings-system-${target}`;
}
const SYSTEM_ROUTE = "/settings/health";

/** Opens Settings > System at the operation, or at the page top when locked or several run. */
function useOpenMaintenance(progress: MaintenanceProgress | null, onBeforeNavigate?: () => void) {
  const router = useRouter();
  const target =
    progress && progress.operations.length === 1 ? progress.operations[0]!.target : null;
  return useCallback(() => {
    onBeforeNavigate?.();
    const jump = {
      pane: "system.health",
      ...(target ? { anchorId: maintenanceAnchorId(target) } : {}),
      focus: true,
    };
    if (!requestSettingsJump(jump)) router.push(SYSTEM_ROUTE);
  }, [onBeforeNavigate, router, target]);
}

// ---------------------------------------------------------------------------------------------
// Sidebar row
// ---------------------------------------------------------------------------------------------

/**
 * One muted row at the bottom of the sidebar while maintenance runs, in the footer's status row
 * style. It is progress, not an owner decision, so it carries no attention badge.
 */
export function MaintenanceSidebarRow({
  rail = false,
  onBeforeNavigate,
}: {
  rail?: boolean;
  onBeforeNavigate?: () => void;
}) {
  const progress = useMaintenanceProgress();
  const shown = hasMaintenance(progress);
  const rule = useFooterLeadingRule("maintenance", shown);
  const now = useClock(shown);
  const open = useOpenMaintenance(progress, onBeforeNavigate);
  if (!shown) return null;
  const { title, detail } = summary(progress, now);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PressHighlight
          style={rail ? styles.rail : styles.row}
          highlightStyle={styles.pressed}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${detail}`}
          accessibilityHint="Opens System settings at this operation"
          onPress={open}
          testID="sidebar-maintenance-status"
        >
          {rule ? <SidebarSeparator edge="top" /> : null}
          <MaintenanceIcon size={16} uniProps={iconColor} />
          {rail ? null : (
            <View style={styles.copy}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.description} numberOfLines={2}>
                {detail}
              </Text>
            </View>
          )}
        </PressHighlight>
      </TooltipTrigger>
      <TooltipContent side="right">
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{detail}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------------------------
// Phone entry
// ---------------------------------------------------------------------------------------------

/**
 * On phones the sidebar is closed, so while maintenance runs a slim line sits above the screen.
 * It takes the top safe-area inset and hands the content beneath a zero top inset, so it moves
 * the page down instead of covering its header.
 */
export function MaintenancePhoneEntry({ children }: { children: ReactNode }) {
  const progress = useMaintenanceProgress();
  const shown = hasMaintenance(progress);
  const insets = useSafeAreaInsets();
  const now = useClock(shown);
  const open = useOpenMaintenance(progress);
  const innerInsets = useMemo(() => ({ ...insets, top: 0 }), [insets]);
  const barStyle = useMemo(() => [styles.phoneBar, { paddingTop: insets.top }], [insets.top]);
  if (!shown) return children;
  const { title, detail } = summary(progress, now);
  return (
    <View style={styles.phoneColumn}>
      <PressHighlight
        style={barStyle}
        highlightStyle={styles.pressed}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${detail}`}
        accessibilityHint="Opens System settings at this operation"
        onPress={open}
        testID="phone-maintenance-status"
      >
        <View style={styles.phoneLine}>
          <MaintenanceIcon size={14} uniProps={iconColor} />
          <Text style={styles.phoneTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.phoneDetail} numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </PressHighlight>
      <SafeAreaInsetsContext.Provider value={innerInsets}>
        <View style={styles.phoneContent}>{children}</View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Settings > System detail
// ---------------------------------------------------------------------------------------------

/** The full progress of a target's operations, under its row in Settings > System. */
export function MaintenanceOperationDetail({ target }: { target: MaintenanceTarget }) {
  const progress = useMaintenanceProgress();
  const operations = progress?.operations.filter((operation) => operation.target === target) ?? [];
  const now = useClock(operations.length > 0);
  if (!progress || operations.length === 0) return null;
  const stale = staleLine(progress);
  return (
    <View style={styles.detail} testID={`maintenance-detail-${target}`}>
      {operations.map((operation) => (
        <View key={operation.id} style={styles.detailOperation}>
          <Text style={styles.detailTitle}>
            {`${operationName(operation)}: ${phaseLine(operation)}`}
          </Text>
          {[
            sinceLine(operation, now),
            stepLine(operation, now),
            estimateLine(operation),
            holdLine(operation),
            blockersLine(operation),
            overdueLine(operation),
          ]
            .filter((line): line is string => Boolean(line))
            .map((line) => (
              <Text key={line} style={styles.description}>
                {line}
              </Text>
            ))}
        </View>
      ))}
      {stale ? <Text style={styles.description}>{stale}</Text> : null}
    </View>
  );
}

/** Health's line while a hold keeps the owner's messages out: progress, not a request. */
export function useMessageHoldNotice(): string | null {
  const progress = useMaintenanceProgress();
  const holding = progress?.operations.find((operation) => operation.holdsMessages);
  if (!holding) return null;
  return `${operationName(holding)} in progress. ${holdLine(holding)}`;
}

// ---------------------------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------------------------

/**
 * The composer's send error. When a tracked hold is keeping new messages out of this thread's
 * daemon, the refusal reads as held, names what it waits for and links to the operation; the
 * draft stays in the input as before. Any other failure renders unchanged.
 */
export function ComposerSendError({
  serverId,
  message,
  style,
}: {
  serverId: string;
  message: string;
  style: StyleProp<TextStyle>;
}) {
  const progress = useMaintenanceProgress();
  const target = serverTarget(serverId);
  const hold = progress && target ? messageHold(progress, target) : null;
  const open = useOpenMaintenance(progress && hold ? { ...progress, operations: [hold] } : null);
  if (!hold) {
    return (
      <Text accessibilityRole="alert" style={style}>
        {message}
      </Text>
    );
  }
  const blockers = blockersLine(hold);
  return (
    <Text accessibilityRole="alert" style={styles.held} testID="composer-maintenance-hold">
      {`Held for the ${operationName(hold)}; your draft is kept. `}
      {blockers ? `${blockers}. ` : null}
      <Text accessibilityRole="link" style={styles.heldLink} onPress={open}>
        See progress
      </Text>
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: 44,
    height: 44,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 48,
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foreground },
  description: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foregroundMuted },
  pressed: { backgroundColor: theme.colors.surface2 },
  phoneColumn: { flex: 1, minHeight: 0 },
  phoneContent: { flex: 1, minHeight: 0 },
  phoneBar: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  phoneLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    minHeight: 32,
  },
  phoneTitle: { flexShrink: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  phoneDetail: { flexShrink: 2, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  detail: { gap: theme.spacing[2], paddingTop: theme.spacing[1] },
  detailOperation: { gap: 2 },
  detailTitle: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  held: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  heldLink: { color: theme.colors.accent, textDecorationLine: "underline" },
}));
