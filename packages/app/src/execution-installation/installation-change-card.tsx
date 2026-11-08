import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { QueuedAgentAction } from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import { useInstallationChangeActions, useInstallationChanges } from "./use-installation-upgrades";

const STATUS: Record<QueuedAgentAction["status"], { label: string; variant: StatusBadgeVariant }> =
  {
    pending: { label: "Waiting", variant: "warning" },
    approved: { label: "Approved", variant: "warning" },
    running: { label: "Applying", variant: "warning" },
    restoring: { label: "Restoring", variant: "error" },
    succeeded: { label: "Applied", variant: "success" },
    failed: { label: "Failed", variant: "error" },
    cancelled: { label: "Cancelled", variant: "muted" },
  };

const ACTION_TITLE: Record<string, string> = {
  "installation-name": "Rename the installation",
  "live-dev": "Change the delivery mode",
  "installation-type": "Change the installation type",
  "installation-settings": "Change installation settings",
  "custom-domain": "Change the custom domain",
};

/** The exact values the change asks for, such as terminal profile commands, for review. */
function requestedValues(job: QueuedAgentAction): string {
  return JSON.stringify(job.request, null, 2);
}

/** How long a finished change stays visible here; older ones remain in the agent's status. */
const RECENT_MS = 24 * 60 * 60_000;

/**
 * Installation changes a Host agent requested. Each shows what it will disrupt, waits for the
 * owner or, under full maintenance delegation, for its thirty-second window, and can be
 * cancelled until it starts.
 */
export function InstallationChangesCard({ client }: { client: InstallationClient | null }) {
  const jobs = (useInstallationChanges(client).data ?? []).filter(
    (job) => !job.finishedAt || Date.now() - Date.parse(job.finishedAt) < RECENT_MS,
  );
  if (!client || jobs.length === 0) return null;
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="installation-changes-card">
      <Text style={settingsStyles.rowTitle}>Requested installation changes</Text>
      {jobs.map((job) => (
        <InstallationChange key={`${job.id}:${job.revision}`} client={client} job={job} />
      ))}
    </View>
  );
}

function InstallationChange({
  client,
  job,
}: {
  client: InstallationClient;
  job: QueuedAgentAction;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const decide = useInstallationChangeActions(client);
  const approve = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: `${ACTION_TITLE[job.action] ?? job.action}?`,
      message: `${job.disruption}\n\nRequested values:\n${requestedValues(job)}`,
      confirmLabel: "Apply",
      destructive: true,
    });
    if (confirmed) decide.mutate({ job, decision: "approve" });
  }, [decide, job]);
  const pressApprove = useCallback(() => void approve(), [approve]);
  const cancel = useCallback(() => decide.mutate({ job, decision: "cancel" }), [decide, job]);
  // A delegated change starts on its own once its window ends; the owner may still approve early.
  const canApprove = job.status === "pending";
  const canCancel = job.status === "pending" || job.status === "approved";
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.key}>{ACTION_TITLE[job.action] ?? job.action}</Text>
        <StatusBadge label={STATUS[job.status].label} variant={STATUS[job.status].variant} />
      </View>
      <Text style={styles.text}>{job.disruption}</Text>
      <Text style={styles.key}>Requested values</Text>
      <Text style={styles.code} selectable testID="installation-change-request">
        {requestedValues(job)}
      </Text>
      <Text style={styles.text}>
        {job.detail} Requested by {job.requester ?? "a Host agent"}.
      </Text>
      {canApprove || canCancel ? (
        <View style={styles.actions}>
          {canApprove ? (
            <Button
              size={controlSize}
              onPress={pressApprove}
              loading={decide.isPending}
              disabled={decide.isPending}
              testID="installation-change-approve"
            >
              Apply
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="outline"
              size={controlSize}
              onPress={cancel}
              disabled={decide.isPending}
              testID="installation-change-cancel"
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
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[3] },
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
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
