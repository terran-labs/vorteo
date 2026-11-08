import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  ExternalLink,
  Minus,
  Undo2,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  UPGRADE_STEP_LABELS,
  type CoordinatorFollowJob,
  type InstallationUpgrade,
  type UpgradeDecision,
  type UpgradeStatus,
  type UpgradeStep,
} from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/duration";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { openExternalUrl } from "@/utils/open-external-url";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import {
  activeUpgrade,
  coordinatorFollowView,
  releaseVersionLabel,
  supportsUpdatePolicy,
  upgradeApprovalText,
  upgradeDecisions,
  upgradeDurationEstimate,
  upgradeDurationText,
  upgradeNotes,
} from "./installation-upgrades-model";
import {
  useCoordinatorFollowActions,
  useCoordinatorFollowStatus,
  useInstallationUpgradeActions,
  useInstallationUpgradeStatus,
} from "./use-installation-upgrades";

const FOLLOW_STATUS: Record<
  CoordinatorFollowJob["status"],
  { label: string; variant: StatusBadgeVariant }
> = {
  pending: { label: "Waiting for approval", variant: "warning" },
  approved: { label: "Approved", variant: "warning" },
  running: { label: "Restarting", variant: "warning" },
  succeeded: { label: "Updated", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  "rolled-back": { label: "Rolled back", variant: "error" },
  rejected: { label: "Rejected", variant: "muted" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

const FOLLOW_CONFIRMATION =
  "The coordinator restarts on the Host release and this interface disconnects briefly. If the new coordinator does not answer within 2 minutes, the previous one is restored automatically. Agents keep running.";

/**
 * Moves the installation coordinator onto the Host release after Host source updates replaced
 * it. Hidden on older coordinators and when the coordinator already runs the Host release.
 */
/** A release folder named by its source commit or job, the last folders of its path. */
function releaseName(release: string): string {
  return release.split("/").filter(Boolean).slice(-2).join("/");
}

/** Which release the coordinator runs and which one it moves to, so the owner sees the target. */
function CoordinatorFollowReleases({ view }: { view: ReturnType<typeof coordinatorFollowView> }) {
  if (view.kind === "job")
    return <Text style={styles.text}>{`Release: ${releaseName(view.job.next)}`}</Text>;
  if (view.kind !== "offer") return null;
  const failed = view.last && view.last.status !== "succeeded";
  return (
    <>
      <Text style={styles.text}>{`Now: ${releaseName(view.current)}`}</Text>
      <Text style={styles.text}>{`Moves to the Host release: ${releaseName(view.next)}`}</Text>
      {failed ? <Text style={styles.text}>{`Last attempt: ${view.last?.detail}`}</Text> : null}
    </>
  );
}

/** Names the Host agent that asked for the update; owner requests show nothing. */
function FollowRequester({ job }: { job: CoordinatorFollowJob | null }) {
  if (job?.requestedBy !== "host-agent") return null;
  return <Text style={styles.text}>Requested by {job.requester ?? "a Host agent"}.</Text>;
}

export function CoordinatorFollowCard({ client }: { client: InstallationClient | null }) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const status = useCoordinatorFollowStatus(client);
  const { start, decide } = useCoordinatorFollowActions(client);
  const view = coordinatorFollowView(status.data);
  const job = view.kind === "job" ? view.job : null;
  const offer = view.kind === "offer" ? view.next : null;
  const confirmAndStart = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: "Update the coordinator?",
      message: FOLLOW_CONFIRMATION,
      confirmLabel: "Update the coordinator",
      destructive: true,
    });
    if (!confirmed) return;
    if (job?.status === "pending") decide.mutate({ job, decision: "approve" });
    else if (offer) start.mutate(offer);
  }, [decide, job, offer, start]);
  const press = useCallback(() => void confirmAndStart(), [confirmAndStart]);
  const cancel = useCallback(() => {
    if (job) decide.mutate({ job, decision: "cancel" });
  }, [decide, job]);
  if (!client || view.kind === "hidden") return null;
  const pending = start.isPending || decide.isPending;
  const canStart = offer !== null || job?.status === "pending";
  const canCancel = job?.status === "pending" || job?.status === "approved";
  const error = start.error ?? decide.error;
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="coordinator-follow-card">
      <View style={styles.header}>
        <Text style={settingsStyles.rowTitle}>Installation coordinator</Text>
        {job ? (
          <StatusBadge
            label={FOLLOW_STATUS[job.status].label}
            variant={FOLLOW_STATUS[job.status].variant}
          />
        ) : null}
      </View>
      <Text style={styles.text}>
        {job ? job.detail : "The coordinator runs an older release than the Host."}
      </Text>
      <FollowRequester job={job} />
      <CoordinatorFollowReleases view={view} />
      {canStart || canCancel ? (
        <View style={styles.actions}>
          {canStart ? (
            <Button
              size={controlSize}
              onPress={press}
              loading={pending}
              disabled={pending}
              testID="coordinator-follow-start"
            >
              Update the coordinator
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="outline"
              size={controlSize}
              onPress={cancel}
              disabled={pending}
              testID="coordinator-follow-cancel"
            >
              Cancel
            </Button>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {toErrorMessage(error)}
        </Text>
      ) : null}
    </View>
  );
}

/** A pending or running upgrade in Installation controls. Details live in Vorteo updates. */
export function InstallationUpgradeCard({ client }: { client: InstallationClient | null }) {
  const status = useInstallationUpgradeStatus(client);
  const upgrade = activeUpgrade(status.data);
  if (!client || !status.data || !upgrade) return null;
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="installation-upgrade-card">
      <InstallationUpgradeDetails client={client} upgrade={upgrade} status={status.data} />
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
 * A pending upgrade shows its release notes, and the owner's decisions appear while it waits.
 */
export function InstallationUpgradeDetails({
  client,
  upgrade,
  status,
}: {
  client: InstallationClient;
  upgrade: InstallationUpgrade;
  status: UpgradeStatus;
}) {
  const live = upgrade.status === "approved" || upgrade.status === "running";
  const now = useNow(live);
  const span = upgradeSpan(upgrade);
  const elapsed = span ? formatDuration((span.end ?? now) - span.start) : null;
  const pending = upgrade.status === "pending";
  return (
    <View style={styles.item} testID={`installation-upgrade-${upgrade.id}`}>
      <UpgradeHeadline upgrade={upgrade} live={live} elapsed={elapsed} />
      {pending ? <UpgradeReleaseNotes upgrade={upgrade} status={status} /> : null}
      <FocusStep upgrade={upgrade} now={now} live={live} />
      <StepList upgrade={upgrade} now={now} />
      <UpgradeDecisionButtons client={client} upgrade={upgrade} status={status} />
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

/**
 * What installing a release changes and how to undo it: the security marker, release summary,
 * restart scope, charter changes, rollback and a link to the full notes.
 */
export function UpgradeReleaseNotes({
  upgrade,
  status,
}: {
  upgrade: InstallationUpgrade;
  status: UpgradeStatus;
}) {
  const notes = upgradeNotes(status, upgrade);
  const openNotes = useCallback(() => {
    if (notes) void openExternalUrl(notes.url);
  }, [notes]);
  const policy = supportsUpdatePolicy(status);
  const restart = status.container
    ? "Restarts the Host daemon, replaces the coordinator and recreates the Dev container."
    : "Restarts the Host daemon and replaces the coordinator.";
  return (
    <View style={styles.notes}>
      {notes?.security ? (
        <View style={styles.security}>
          <StatusBadge label="Security fix" variant="error" />
        </View>
      ) : null}
      {notes?.summary ? <Text style={styles.summary}>{notes.summary}</Text> : null}
      <Text style={styles.text}>
        {policy
          ? `${restart} Install after current work holds new work and waits for running turns and Dev agents to finish.`
          : `${restart} Running agents are interrupted.`}
      </Text>
      {notes && notes.charterChanges.length > 0 ? (
        <Text style={styles.text}>
          {`Factory charters that change: ${notes.charterChanges.join("; ")}`}
        </Text>
      ) : null}
      <Text style={styles.text}>
        {upgradeDurationText(upgradeDurationEstimate(status.upgrades), status.container)}
      </Text>
      <Text style={styles.text}>
        A safety snapshot is taken first; restore it from Installation controls if anything breaks.
      </Text>
      {notes ? (
        <View style={styles.link}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ExternalLink}
            onPress={openNotes}
            testID={`installation-upgrade-notes-${upgrade.id}`}
          >
            Release notes
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const DECISION_LABELS: Partial<Record<UpgradeDecision["decision"], string>> = {
  "approve-after-work": "Install after current work",
  reject: "Skip this release",
};

/**
 * Install after current work, Install now and Skip this release for a pending upgrade, and
 * Install now for one waiting on current work. Coordinators without an update policy accept
 * only an immediate approval of a pending upgrade, offered as Install.
 */
export function UpgradeDecisionButtons({
  client,
  upgrade,
  status,
}: {
  client: InstallationClient;
  upgrade: InstallationUpgrade;
  status: UpgradeStatus;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const { decide } = useInstallationUpgradeActions(client);
  const decisions = upgradeDecisions(status, upgrade);
  // With an update policy, Install now always means "do not wait", which interrupts agents.
  const canWait = supportsUpdatePolicy(status);
  const choose = useCallback(
    async (decision: UpgradeDecision["decision"]) => {
      if (decision === "approve" && canWait) {
        const confirmed = await confirmDialog({
          title: `Install Vorteo ${releaseVersionLabel(upgrade.release)} now?`,
          message: upgradeApprovalText(status.container, false, status.upgrades),
          confirmLabel: "Install now",
          destructive: true,
        });
        if (!confirmed) return;
      }
      decide.mutate({ upgrade, decision });
    },
    [canWait, decide, status.container, status.upgrades, upgrade],
  );
  if (decisions.length === 0) return null;
  return (
    <View style={styles.decisions}>
      <View style={styles.actions}>
        {decisions.map((decision, index) => (
          <DecisionButton
            key={decision}
            decision={decision}
            primary={index === 0}
            size={controlSize}
            label={DECISION_LABELS[decision] ?? (canWait ? "Install now" : "Install")}
            pending={decide.isPending}
            loading={decide.isPending && decide.variables?.decision === decision}
            onChoose={choose}
          />
        ))}
      </View>
      <SettingsStatusLine message={decide.error ? toErrorMessage(decide.error) : null} />
    </View>
  );
}

function DecisionButton({
  decision,
  primary,
  size,
  label,
  pending,
  loading,
  onChoose,
}: {
  decision: UpgradeDecision["decision"];
  primary: boolean;
  size: "sm" | "md";
  label: string;
  pending: boolean;
  loading: boolean;
  onChoose: (decision: UpgradeDecision["decision"]) => Promise<void>;
}) {
  const press = useCallback(() => void onChoose(decision), [decision, onChoose]);
  return (
    <Button
      variant={primary ? "default" : "outline"}
      size={size}
      onPress={press}
      disabled={pending}
      loading={loading}
      testID={`installation-upgrade-${decision}`}
    >
      {label}
    </Button>
  );
}

/** Dismisses the notice of an automatic upgrade that finished. */
export function UpgradeAcknowledgeButton({
  client,
  upgrade,
}: {
  client: InstallationClient;
  upgrade: InstallationUpgrade;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const { decide } = useInstallationUpgradeActions(client);
  const dismiss = useCallback(
    () => decide.mutate({ upgrade, decision: "acknowledge" }),
    [decide, upgrade],
  );
  return (
    <View style={styles.decisions}>
      <View style={styles.actions}>
        <Button
          variant="outline"
          size={controlSize}
          onPress={dismiss}
          loading={decide.isPending}
          disabled={decide.isPending}
          testID="installation-upgrade-acknowledge"
        >
          Dismiss
        </Button>
      </View>
      <SettingsStatusLine message={decide.error ? toErrorMessage(decide.error) : null} />
    </View>
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
  notes: { gap: theme.spacing[1.5] },
  security: { flexDirection: "row" },
  link: { flexDirection: "row" },
  decisions: { gap: theme.spacing[1.5] },
  summary: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
