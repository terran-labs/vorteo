import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  holdLine,
  maintenanceProgress,
  messageHold,
  operationName,
  type MaintenanceOperation,
  type MaintenanceProgress,
  type MaintenanceTarget,
} from "./maintenance-progress";
import { sendNotice } from "@/composer/submit";
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

/** An operation that finished while the app was watching, shown briefly so it does not vanish. */
export interface FinishedOperation {
  id: string;
  name: string;
  at: string;
}
export type LiveMaintenance = MaintenanceProgress & { finished: FinishedOperation[] };

/** How long a finished operation stays mentioned. A failure keeps its own attention item. */
const FINISHED_SHOWN_MS = 60_000;

/** The live maintenance snapshot, or null where this app has no installation. */
export function useMaintenanceProgress(): LiveMaintenance | null {
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
  const progress = useMemo(() => {
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
  const finished = useRecentlyFinished(progress, state?.jobs, state?.serviceQueue?.jobs);
  return useMemo(() => (progress ? { ...progress, finished } : null), [finished, progress]);
}

interface TrackedRecord {
  id: string;
  status: string;
  finishedAt?: string;
}

/**
 * Operations that left the running list because they succeeded, kept for a minute. The finish
 * time is the coordinator's when it reports one, otherwise when this app saw it end.
 */
function useRecentlyFinished(
  progress: MaintenanceProgress | null,
  jobs: readonly TrackedRecord[] | undefined,
  serviceJobs: readonly TrackedRecord[] | undefined,
): FinishedOperation[] {
  const seen = useRef(new Map<string, MaintenanceOperation>());
  const [finished, setFinished] = useState<FinishedOperation[]>([]);
  useEffect(() => {
    if (!progress) return;
    const records = [...(jobs ?? []), ...(serviceJobs ?? [])];
    const active = new Map(progress.operations.map((operation) => [operation.id, operation]));
    const ended: FinishedOperation[] = [];
    for (const [id, operation] of seen.current) {
      if (active.has(id)) continue;
      const record = records.find((job) => job.id === id);
      if (record?.status !== "succeeded") continue;
      ended.push({
        id,
        name: operationName(operation),
        at: record.finishedAt ?? new Date().toISOString(),
      });
    }
    seen.current = active;
    if (ended.length) setFinished((current) => [...current, ...ended]);
  }, [jobs, progress, serviceJobs]);
  useEffect(() => {
    if (!finished.length) return;
    const expire = () =>
      setFinished((current) =>
        current.filter((entry) => Date.now() - Date.parse(entry.at) < FINISHED_SHOWN_MS),
      );
    const timer = setTimeout(expire, FINISHED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [finished]);
  return finished;
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
export function sinceLine(operation: MaintenanceOperation, now: number): string | null {
  if (!operation.since) return null;
  const elapsed = formatDuration(now - Date.parse(operation.since.at));
  if (operation.since.from === "started") return `${elapsed} so far`;
  if (operation.since.from === "approved") return `${elapsed} since approved`;
  return `${elapsed} since requested`;
}

/** Time in the current step; null when the coordinator does not report steps. */
export function stepLine(operation: MaintenanceOperation, now: number): string | null {
  if (!operation.stepSince) return operation.startUnknown ? "Start time unknown" : null;
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

export function overdueLine(operation: MaintenanceOperation): string | null {
  if (!operation.overdue) return null;
  const notice = operation.requesterNotNotified ? " The requester has not been told." : "";
  return `Past its deadline; it needs your decision.${notice}`;
}

function staleLine(progress: MaintenanceProgress): string | null {
  if (!progress.staleSince) return null;
  return `Status not updated since ${clockTime(progress.staleSince)}`;
}

const LOCKED_DETAIL = "Unlock System settings to see what it is doing.";

function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The one-line summary the sidebar row and the phone entry show. */
function summary(progress: LiveMaintenance, now: number): { title: string; detail: string } {
  if (progress.locked) {
    return {
      title: progress.locked.running ? "Maintenance is running" : "Maintenance is waiting to start",
      detail: LOCKED_DETAIL,
    };
  }
  if (progress.operations.length === 0) {
    const last = progress.finished[progress.finished.length - 1]!;
    return { title: `${last.name} finished`, detail: `at ${clockTime(last.at)}` };
  }
  const [first] = progress.operations;
  const stale = staleLine(progress);
  if (progress.operations.length > 1) {
    // Names first, so a narrow phone line still says what is running; the oldest sets the time.
    const holding = progress.operations.some((operation) => operation.holdsMessages);
    const oldest = progress.operations.reduce((left, right) =>
      Date.parse(right.since?.at ?? "") < Date.parse(left.since?.at ?? "") ? right : left,
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

function hasMaintenance(progress: LiveMaintenance | null): progress is LiveMaintenance {
  return Boolean(
    progress && (progress.locked || progress.operations.length > 0 || progress.finished.length > 0),
  );
}

/** The System page anchor for a target's row; System services share the page's top. */
export function maintenanceAnchorId(target: MaintenanceTarget): string {
  return target === "system" ? "settings-system-services" : `settings-system-${target}`;
}
const SYSTEM_ROUTE = "/settings/health";

/** Opens Settings > System at the operation, or at the page top when locked or several run. */
function useOpenMaintenance(
  progress: Pick<MaintenanceProgress, "operations"> | null,
  onBeforeNavigate?: () => void,
) {
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
  // One constant tree whether or not maintenance runs: only the bar and the inset change, so
  // the page beneath is never remounted while the owner is typing.
  const innerInsets = useMemo(() => (shown ? { ...insets, top: 0 } : insets), [insets, shown]);
  const barStyle = useMemo(() => [styles.phoneBar, { paddingTop: insets.top }], [insets.top]);
  const line = shown ? summary(progress, now) : null;
  return (
    <View style={styles.phoneColumn}>
      {line ? (
        <PressHighlight
          style={barStyle}
          highlightStyle={styles.pressed}
          accessibilityRole="button"
          accessibilityLabel={`${line.title}. ${line.detail}`}
          accessibilityHint="Opens System settings at this operation"
          onPress={open}
          testID="phone-maintenance-status"
        >
          <View style={styles.phoneLine}>
            <MaintenanceIcon size={14} uniProps={iconColor} />
            <Text style={styles.phoneTitle} numberOfLines={1}>
              {line.title}
            </Text>
            <Text style={styles.phoneDetail} numberOfLines={1}>
              {line.detail}
            </Text>
          </View>
        </PressHighlight>
      ) : null}
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

// ---------------------------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------------------------

/**
 * The composer's send error. Only the daemon's restart-hold refusal, while a tracked hold is
 * active for this thread's daemon, reads as held: the daemon did not keep the message, the draft
 * stays in the input, and the line names what the hold waits for and links to its progress.
 * Every other failure, including one during a hold, shows its own message unchanged.
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
  const tracked = progress && target ? messageHold(progress, target) : null;
  const hold =
    sendNotice({ result: "failed", error: message, holdActive: tracked !== null }) === "held"
      ? tracked
      : null;
  const open = useOpenMaintenance(hold ? { operations: [hold] } : null);
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
      {`Not sent: the ${operationName(hold)} is holding new messages until it finishes. Your draft is kept; send it again afterwards. `}
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
  // Held is neither a failure (red) nor queued (muted): the warning colour, as Settings uses for it.
  held: { fontSize: theme.fontSize.sm, color: theme.colors.statusWarning },
  heldLink: { color: theme.colors.accent, textDecorationLine: "underline" },
}));
