import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CoordinatorSettingsJob } from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import { coordinatorSettingsView } from "./coordinator-settings-model";
import {
  useCoordinatorFollowStatus,
  useCoordinatorSettingsActions,
  useCoordinatorSettingsStatus,
} from "./use-installation-upgrades";

const STATUS: Record<
  CoordinatorSettingsJob["status"],
  { label: string; variant: StatusBadgeVariant }
> = {
  pending: { label: "Waiting for approval", variant: "warning" },
  approved: { label: "Approved", variant: "warning" },
  running: { label: "Restarting", variant: "warning" },
  succeeded: { label: "Applied", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  "rolled-back": { label: "Rolled back", variant: "error" },
  rejected: { label: "Rejected", variant: "muted" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

const CONFIRMATION =
  "The coordinator restarts with these settings and this interface disconnects briefly. If it does not answer within 2 minutes, the previous settings are restored automatically. Agents keep running.";
const COMBINED_CONFIRMATION =
  "The coordinator first restarts on the Host release, then restarts again with these settings. Each step is restored automatically if the coordinator does not answer within 2 minutes; if the update fails, the settings stay waiting. Agents keep running.";

/**
 * A change to registered coordinator settings that an agent requested. Hidden on older
 * coordinators and when no change is waiting, running or recently finished.
 */
export function CoordinatorSettingsCard({ client }: { client: InstallationClient | null }) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const status = useCoordinatorSettingsStatus(client);
  const followStatus = useCoordinatorFollowStatus(client);
  const decide = useCoordinatorSettingsActions(client);
  const view = coordinatorSettingsView(status.data, followStatus.data);
  const job = view.kind === "job" ? view.job : null;
  const follow = view.kind === "job" ? view.follow : null;
  const approve = useCallback(
    async (combined: boolean) => {
      if (!job) return;
      const confirmed = await confirmDialog({
        title: combined ? "Update the coordinator and apply settings?" : "Apply these settings?",
        message: combined ? COMBINED_CONFIRMATION : CONFIRMATION,
        confirmLabel: combined ? "Update and apply" : "Apply settings",
        destructive: true,
      });
      if (!confirmed) return;
      decide.mutate({
        job,
        decision: "approve",
        ...(combined && follow ? { follow } : {}),
      });
    },
    [decide, follow, job],
  );
  const approveAlone = useCallback(() => void approve(false), [approve]);
  const approveCombined = useCallback(() => void approve(true), [approve]);
  const reject = useCallback(() => {
    if (job) decide.mutate({ job, decision: "reject" });
  }, [decide, job]);
  const cancel = useCallback(() => {
    if (job) decide.mutate({ job, decision: "cancel" });
  }, [decide, job]);
  if (!client || view.kind === "hidden" || !job) return null;
  const waiting = job.status === "pending" && !job.approvedWith;
  const canCancel = job.status === "pending" || job.status === "approved";
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="coordinator-settings-card">
      <View style={styles.header}>
        <Text style={settingsStyles.rowTitle}>Coordinator settings</Text>
        <StatusBadge label={STATUS[job.status].label} variant={STATUS[job.status].variant} />
      </View>
      <Text style={styles.text}>{job.detail}</Text>
      {view.rows.map((row) => (
        <View key={row.key} style={styles.row}>
          <Text style={styles.key}>{row.key}</Text>
          <Text style={styles.text} selectable>
            {row.before} → {row.after}
          </Text>
        </View>
      ))}
      {waiting || canCancel ? (
        <View style={styles.actions}>
          {waiting && follow ? (
            <Button
              size={controlSize}
              onPress={approveCombined}
              loading={decide.isPending}
              disabled={decide.isPending}
              testID="coordinator-settings-approve-with-follow"
            >
              Update the coordinator and apply settings
            </Button>
          ) : null}
          {waiting ? (
            <Button
              variant={follow ? "outline" : "default"}
              size={controlSize}
              onPress={approveAlone}
              loading={decide.isPending && !follow}
              disabled={decide.isPending}
              testID="coordinator-settings-approve"
            >
              Approve
            </Button>
          ) : null}
          {job.status === "pending" ? (
            <Button
              variant="outline"
              size={controlSize}
              onPress={reject}
              disabled={decide.isPending}
              testID="coordinator-settings-reject"
            >
              Reject
            </Button>
          ) : null}
          {job.status === "approved" ? (
            <Button
              variant="outline"
              size={controlSize}
              onPress={cancel}
              disabled={decide.isPending}
              testID="coordinator-settings-cancel"
            >
              Cancel
            </Button>
          ) : null}
        </View>
      ) : null}
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
  row: { gap: theme.spacing[1] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  key: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
