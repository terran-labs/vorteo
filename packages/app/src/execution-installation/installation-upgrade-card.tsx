import { ExternalLink } from "lucide-react-native";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  CoordinatorFollowJob,
  InstallationUpgrade,
  UpgradeDecision,
  UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { openExternalUrl } from "@/utils/open-external-url";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import {
  activeUpgrade,
  coordinatorFollowView,
  upgradeDecisions,
  releaseVersionLabel,
  supportsUpdatePolicy,
  upgradeApprovalText,
  upgradeNotes,
  upgradeStatusLabel,
  upgradeStepRows,
  type UpgradeStepRow,
} from "./installation-upgrades-model";
import {
  useCoordinatorFollowActions,
  useCoordinatorFollowStatus,
  useInstallationUpgradeActions,
  useInstallationUpgradeStatus,
} from "./use-installation-upgrades";

const STATUS_VARIANTS: Record<InstallationUpgrade["status"], StatusBadgeVariant> = {
  pending: "warning",
  approved: "warning",
  running: "warning",
  succeeded: "success",
  failed: "error",
  rejected: "muted",
  cancelled: "muted",
};

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

const STEP_STATUS_LABELS: Record<UpgradeStepRow["status"], string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  "rolled-back": "Rolled back",
};

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

/** One upgrade with its steps, plus the owner's decisions while it waits. */
export function InstallationUpgradeDetails({
  client,
  upgrade,
  status,
}: {
  client: InstallationClient;
  upgrade: InstallationUpgrade;
  status: UpgradeStatus;
}) {
  const pending = upgrade.status === "pending";
  return (
    <View style={styles.item} testID={`installation-upgrade-${upgrade.id}`}>
      <View style={styles.header}>
        <Text style={settingsStyles.rowTitle}>Upgrade to {upgrade.release}</Text>
        <StatusBadge
          label={upgradeStatusLabel(upgrade)}
          variant={STATUS_VARIANTS[upgrade.status]}
        />
      </View>
      {pending ? <UpgradeReleaseNotes upgrade={upgrade} status={status} /> : null}
      {upgrade.detail ? <Text style={styles.text}>{upgrade.detail}</Text> : null}
      {upgradeStepRows(upgrade).map((step) => (
        <Text key={step.name} style={styles.text} testID={`installation-upgrade-step-${step.name}`}>
          {`${step.label}: ${STEP_STATUS_LABELS[step.status]}${step.detail ? `. ${step.detail}` : ""}`}
        </Text>
      ))}
      {pending ? (
        <UpgradeDecisionButtons client={client} upgrade={upgrade} status={status} />
      ) : null}
    </View>
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
          message: upgradeApprovalText(status.container),
          confirmLabel: "Install now",
          destructive: true,
        });
        if (!confirmed) return;
      }
      decide.mutate({ upgrade, decision });
    },
    [canWait, decide, status.container, upgrade],
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
      {decide.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {toErrorMessage(decide.error)}
        </Text>
      ) : null}
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
      {decide.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {toErrorMessage(decide.error)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[2] },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  item: { gap: theme.spacing[2] },
  notes: { gap: theme.spacing[1.5] },
  security: { flexDirection: "row" },
  link: { flexDirection: "row" },
  decisions: { gap: theme.spacing[1.5] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  summary: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
