import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Minus,
  Undo2,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  UPGRADE_STEP_LABELS,
  type InstallationUpgrade,
  type UpgradeStep,
} from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/duration";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import { activeUpgrade, upgradeApprovalText } from "./installation-upgrades-model";
import {
  useInstallationUpgradeActions,
  useInstallationUpgradeStatus,
} from "./use-installation-upgrades";

/** A pending or running upgrade in Installation controls. Details live in Vorteo updates. */
export function InstallationUpgradeCard({ client }: { client: InstallationClient | null }) {
  const status = useInstallationUpgradeStatus(client);
  const upgrade = activeUpgrade(status.data);
  if (!client || !status.data || !upgrade) return null;
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="installation-upgrade-card">
      <InstallationUpgradeDetails
        client={client}
        upgrade={upgrade}
        hasDev={status.data.container}
        upgrades={status.data.upgrades}
      />
    </View>
  );
}

type Tone = "active" | "success" | "danger" | "muted";

/** The headline for each upgrade status; the timer and active step carry the rest. */
function headline(upgrade: InstallationUpgrade, elapsed: string | null): string {
  const release = upgrade.release;
  switch (upgrade.status) {
    case "pending":
      return `Upgrade to ${release} is waiting for your approval`;
    case "approved":
      return `Starting the upgrade to ${release}`;
    case "running":
      return `Upgrading to ${release}`;
    case "succeeded":
      return elapsed ? `Upgraded to ${release} in ${elapsed}` : `Upgraded to ${release}`;
    case "failed":
      return elapsed
        ? `Upgrade to ${release} failed after ${elapsed}`
        : `Upgrade to ${release} failed`;
    case "rejected":
      return `Upgrade to ${release} was rejected`;
    case "cancelled":
      return `Upgrade to ${release} was cancelled`;
  }
}

function upgradeTone(status: InstallationUpgrade["status"]): Tone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "rejected" || status === "cancelled") return "muted";
  return "active";
}

/** The step to show by default: the one running, the one that failed, or the next one due. */
function focusStep(upgrade: InstallationUpgrade): UpgradeStep | null {
  const { steps, status } = upgrade;
  return (
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "failed") ??
    (status === "approved" || status === "running"
      ? (steps.find((step) => step.status === "pending") ?? null)
      : null)
  );
}

const time = (value: string | undefined) => (value ? Date.parse(value) : Number.NaN);

/** When the upgrade started working, and when it stopped; null end while it still runs. */
function upgradeSpan(upgrade: InstallationUpgrade): { start: number; end: number | null } | null {
  const starts = upgrade.steps.map((step) => time(step.startedAt)).filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : time(upgrade.approvedAt);
  if (!Number.isFinite(start)) return null;
  if (upgrade.status === "approved" || upgrade.status === "running") return { start, end: null };
  const ends = upgrade.steps.map((step) => time(step.finishedAt)).filter(Number.isFinite);
  return ends.length ? { start, end: Math.max(...ends) } : null;
}

function stepDuration(step: UpgradeStep, now: number): string | null {
  const start = time(step.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = step.status === "running" ? now : time(step.finishedAt);
  return Number.isFinite(end) ? formatDuration(end - start) : null;
}

/** Re-renders every second while `live`, for elapsed timers. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * One upgrade, from first principles: a headline with a status icon and a running timer, then
 * the single step that matters now, highlighted. The full step list stays behind a disclosure.
 * Approve and Reject appear while it waits for the owner.
 */
export function InstallationUpgradeDetails({
  client,
  upgrade,
  hasDev,
  upgrades,
}: {
  client: InstallationClient;
  upgrade: InstallationUpgrade;
  hasDev: boolean;
  /** Every upgrade on record, so the approval text can quote how long the last one took. */
  upgrades?: readonly InstallationUpgrade[];
}) {
  const live = upgrade.status === "approved" || upgrade.status === "running";
  const now = useNow(live);
  const span = upgradeSpan(upgrade);
  const elapsed = span ? formatDuration((span.end ?? now) - span.start) : null;
  const pending = upgrade.status === "pending";
  return (
    <View style={styles.item} testID={`installation-upgrade-${upgrade.id}`}>
      <UpgradeHeadline upgrade={upgrade} live={live} elapsed={elapsed} />
      {pending ? <Text style={styles.text}>{upgradeApprovalText(hasDev, upgrades)}</Text> : null}
      <FocusStep upgrade={upgrade} now={now} live={live} />
      <StepList upgrade={upgrade} now={now} />
      {pending ? <ApprovalActions client={client} upgrade={upgrade} /> : null}
    </View>
  );
}

function UpgradeHeadline({
  upgrade,
  live,
  elapsed,
}: {
  upgrade: InstallationUpgrade;
  live: boolean;
  elapsed: string | null;
}) {
  const muted = upgradeTone(upgrade.status) === "muted";
  return (
    <View style={styles.header}>
      <StatusIcon status={upgrade.status === "pending" ? "waiting" : upgrade.status} />
      <Text style={[styles.title, muted && styles.muted]} numberOfLines={2}>
        {headline(upgrade, live ? null : elapsed)}
      </Text>
      {live && elapsed ? (
        <Text style={styles.timer} accessibilityLabel={`Elapsed ${elapsed}`}>
          {elapsed}
        </Text>
      ) : null}
    </View>
  );
}

/** The step that matters now; a finished upgrade with no such step shows its summary detail. */
function FocusStep({
  upgrade,
  now,
  live,
}: {
  upgrade: InstallationUpgrade;
  now: number;
  live: boolean;
}) {
  const focus = focusStep(upgrade);
  if (!focus) {
    return upgrade.detail && !live ? <Text style={styles.text}>{upgrade.detail}</Text> : null;
  }
  return (
    <View
      style={[styles.focus, focus.status === "failed" && styles.focusFailed]}
      testID={`installation-upgrade-step-${focus.name}`}
    >
      <View style={styles.stepLine}>
        <StatusIcon status={focus.status} />
        <Text style={styles.focusLabel}>{UPGRADE_STEP_LABELS[focus.name]}</Text>
        <Text style={styles.stepTime}>{stepDuration(focus, now) ?? ""}</Text>
      </View>
      {focus.detail ? <Text style={styles.focusDetail}>{focus.detail}</Text> : null}
    </View>
  );
}

/** Every step as a bullet list with its icon and duration, behind a disclosure. */
function StepList({ upgrade, now }: { upgrade: InstallationUpgrade; now: number }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  if (upgrade.steps.length === 0) return null;
  const done = upgrade.steps.filter((step) => step.status === "succeeded").length;
  const focus = focusStep(upgrade);
  return (
    <>
      <View style={styles.disclosure}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={open ? ChevronDown : ChevronRight}
          onPress={toggle}
          testID="installation-upgrade-steps-toggle"
        >
          {`${open ? "Hide" : "Show"} all steps (${done} of ${upgrade.steps.length} done)`}
        </Button>
      </View>
      {open ? (
        <View style={styles.steps} testID="installation-upgrade-steps">
          {upgrade.steps.map((step) => (
            <View key={step.name} style={styles.stepRow}>
              <View style={styles.stepLine}>
                <StatusIcon status={step.status} />
                <Text
                  style={[styles.stepLabel, step.status === "pending" && styles.muted]}
                  numberOfLines={2}
                >
                  {UPGRADE_STEP_LABELS[step.name]}
                </Text>
                <Text style={styles.stepTime}>{stepDuration(step, now) ?? ""}</Text>
              </View>
              {step.detail && step.name !== focus?.name ? (
                <Text style={styles.stepDetail}>{step.detail}</Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

function ApprovalActions({
  client,
  upgrade,
}: {
  client: InstallationClient;
  upgrade: InstallationUpgrade;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const { decide } = useInstallationUpgradeActions(client);
  const approve = useCallback(
    () => decide.mutate({ upgrade, decision: "approve" }),
    [decide, upgrade],
  );
  const reject = useCallback(
    () => decide.mutate({ upgrade, decision: "reject" }),
    [decide, upgrade],
  );
  return (
    <>
      <View style={styles.actions}>
        <Button
          size={controlSize}
          onPress={approve}
          disabled={decide.isPending}
          testID="installation-upgrade-approve"
        >
          Approve upgrade
        </Button>
        <Button
          variant="outline"
          size={controlSize}
          onPress={reject}
          disabled={decide.isPending}
          testID="installation-upgrade-reject"
        >
          Reject
        </Button>
      </View>
      {decide.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {toErrorMessage(decide.error)}
        </Text>
      ) : null}
    </>
  );
}

type IconStatus = UpgradeStep["status"] | InstallationUpgrade["status"] | "waiting";
type ColorKey = "statusSuccess" | "statusDanger" | "statusWarning" | "foregroundMuted";

const ICONS: Partial<Record<IconStatus, { Icon: ComponentType<IconProps>; color: ColorKey }>> = {
  succeeded: { Icon: Check, color: "statusSuccess" },
  failed: { Icon: X, color: "statusDanger" },
  "rolled-back": { Icon: Undo2, color: "statusWarning" },
  skipped: { Icon: Minus, color: "foregroundMuted" },
  rejected: { Icon: Minus, color: "foregroundMuted" },
  cancelled: { Icon: Minus, color: "foregroundMuted" },
  waiting: { Icon: Clock, color: "statusWarning" },
};

interface IconProps {
  size?: number;
  color?: string;
}

function ThemedGlyph({ Icon, size, color }: IconProps & { Icon: ComponentType<IconProps> }) {
  return <Icon size={size} color={color} />;
}
const ThemedIcon = withUnistyles(ThemedGlyph);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerColor = (theme: Theme) => ({ color: theme.colors.foreground });
const iconColors = {
  statusSuccess: (theme: Theme) => ({ color: theme.colors.statusSuccess }),
  statusDanger: (theme: Theme) => ({ color: theme.colors.statusDanger }),
  statusWarning: (theme: Theme) => ({ color: theme.colors.statusWarning }),
  foregroundMuted: (theme: Theme) => ({ color: theme.colors.foregroundMuted }),
} as const;

/** A 16px slot so labels align whether a step shows a spinner, a check or a dot. */
function StatusIcon({ status }: { status: IconStatus }) {
  let icon;
  if (status === "running" || status === "approved") {
    icon = <ThemedSpinner size={14} uniProps={spinnerColor} />;
  } else {
    const entry = ICONS[status];
    icon = entry ? (
      <ThemedIcon Icon={entry.Icon} size={14} uniProps={iconColors[entry.color]} />
    ) : (
      <ThemedIcon Icon={Circle} size={8} uniProps={iconColors.foregroundMuted} />
    );
  }
  return <View style={styles.icon}>{icon}</View>;
}

const styles = StyleSheet.create((theme) => ({
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[2] },
  item: { gap: theme.spacing[2] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  timer: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  icon: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  // The one step that matters now, set apart from the list.
  focus: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  focusFailed: { borderColor: theme.colors.statusDanger },
  focusLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  focusDetail: {
    marginLeft: 16 + theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  disclosure: { flexDirection: "row", marginLeft: -theme.spacing[2] },
  steps: { gap: theme.spacing[2], paddingLeft: theme.spacing[1] },
  stepRow: { gap: 2 },
  stepLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  stepLabel: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  stepTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  stepDetail: {
    marginLeft: 16 + theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
  },
  muted: { color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
