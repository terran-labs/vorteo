import { useCallback, useMemo, type ReactNode } from "react";
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
import type { Theme } from "@/styles/theme";
import {
  blockersLine,
  clockTime,
  messageHold,
  operationName,
  phaseLine,
  sinceLine,
  staleLine,
  type MaintenanceProgress,
} from "./maintenance-progress";
import {
  maintenanceAnchorId,
  useClock,
  useMaintenanceProgress,
  type LiveMaintenance,
} from "./maintenance-detail";
import { serverTarget } from "./maintenance-model-source";
import { sendNotice } from "@/composer/submit";

/**
 * Running installation maintenance, shown the same way everywhere (#720): one sidebar row, one
 * phone entry, the Host and Dev rows in Settings > System, Health and the composer. All read
 * `useMaintenanceProgress`, which reads the installation session the app already polls.
 */

const MaintenanceIcon = withUnistyles(Wrench);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// ---------------------------------------------------------------------------------------------
// Words. Plain English, shared by every surface, as the rest of Settings > System is written.
// ---------------------------------------------------------------------------------------------

const LOCKED_DETAIL = "Unlock System settings to see what it is doing.";

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

function hasMaintenance(progress: LiveMaintenance | null): progress is LiveMaintenance {
  return Boolean(
    progress && (progress.locked || progress.operations.length > 0 || progress.finished.length > 0),
  );
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
