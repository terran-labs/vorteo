import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import type {
  MaintenanceServiceQueueStatus,
  MaintenanceServiceView,
} from "@getpaseo/protocol/maintenance-service-status";

export interface MaintenanceServiceQueueProps {
  status: MaintenanceServiceQueueStatus | null;
  error: string | null;
  refreshing: boolean;
  busy: boolean;
  onRefresh(): void;
  onCancel(job: MaintenanceServiceView): void;
  /**
   * Dismiss for failures that still count on System Health, on coordinators that record the
   * owner's dismissals (issue #639). Absent elsewhere.
   */
  dismissal?: HealthDismissalControls | null;
}

export interface HealthDismissalControls {
  /** Failures System Health still counts. */
  counted: ReadonlySet<string>;
  /** Failures the owner dismissed; they stay listed. */
  dismissed: ReadonlySet<string>;
  onDismiss(job: MaintenanceServiceView): void;
}

/** These are durable request receipts, not current service health observations. */
export function MaintenanceServiceQueue({
  status,
  error,
  refreshing,
  busy,
  onRefresh,
  onCancel,
  dismissal = null,
}: MaintenanceServiceQueueProps) {
  // Nothing to show until requests exist; status refreshes on its own.
  if (!error && (!status || (status.available && status.jobs.length === 0))) return null;
  return (
    <View style={styles.queue} testID="maintenance-request-queue">
      <View style={styles.heading}>
        <Text style={settingsStyles.rowTitle}>Maintenance requests</Text>
        {error ? (
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            loading={refreshing}
            onPress={onRefresh}
          >
            Refresh requests
          </Button>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      {status && !status.available ? (
        <Text style={styles.hint}>
          Maintenance execution is unavailable. Recorded requests remain visible.
        </Text>
      ) : null}
      {status?.jobs.map((job) => (
        <MaintenanceRequestRow
          key={job.id}
          job={job}
          disabled={busy || Boolean(error)}
          onCancel={onCancel}
          dismissal={dismissal}
        />
      ))}
    </View>
  );
}
function MaintenanceRequestRow({
  job,
  disabled,
  onCancel,
  dismissal,
}: {
  job: MaintenanceServiceView;
  disabled: boolean;
  onCancel(job: MaintenanceServiceView): void;
  dismissal: HealthDismissalControls | null;
}) {
  const cancel = useCallback(() => onCancel(job), [onCancel, job]);
  const dismiss = useCallback(() => dismissal?.onDismiss(job), [dismissal, job]);
  const dismissed = job.status === "failed" && Boolean(dismissal?.dismissed.has(job.id));
  const target =
    job.target === "maintenance-controller" ? "Maintenance controller" : "Recovery launcher";
  return (
    <View style={styles.request} testID={`maintenance-request-${job.id}`}>
      <View style={styles.heading}>
        <Text style={settingsStyles.rowTitle}>{target}</Text>
        {/* A polite live region, so a status change while the page is open is announced. */}
        <View accessibilityLiveRegion="polite" aria-live="polite">
          {dismissed ? (
            <StatusBadge label={DISMISSED_LABEL} variant="muted" />
          ) : (
            <StatusBadge label={labels[job.status]} variant={variants[job.status]} />
          )}
        </View>
      </View>
      <Text style={styles.hint}>{job.reason}</Text>
      <Text style={styles.hint}>{job.detail}</Text>
      {job.dispatchAfter && job.status === "approved" ? (
        <Text style={styles.hint}>
          Eligible after {new Date(job.dispatchAfter).toLocaleTimeString()}. You can cancel until
          dispatch.
        </Text>
      ) : null}
      {job.observedAt ? (
        <Text style={styles.hint}>Last checked {new Date(job.observedAt).toLocaleString()}</Text>
      ) : null}
      {dismissal?.counted.has(job.id) && job.status === "failed" ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            disabled={disabled}
            onPress={dismiss}
            accessibilityLabel="Dismiss failed service maintenance request"
            testID={`health-dismiss-${job.id}`}
          >
            Dismiss
          </Button>
        </View>
      ) : null}
      {job.cancelable ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            disabled={disabled}
            onPress={cancel}
            accessibilityLabel={`Cancel ${target} maintenance`}
          >
            Cancel maintenance
          </Button>
        </View>
      ) : null}
    </View>
  );
}
// A badge, not a settings row.
const DISMISSED_LABEL = "Dismissed";
const variants = {
  pending: "warning",
  approved: "warning",
  running: "warning",
  succeeded: "success",
  failed: "error",
  rejected: "warning",
} as const;
const labels = {
  pending: "Requested",
  approved: "Scheduled",
  running: "Checking",
  succeeded: "Candidate verified",
  failed: "Needs attention",
  rejected: "Closed",
} as const;
const styles = StyleSheet.create((theme) => ({
  queue: { padding: theme.spacing[4], gap: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  request: { paddingVertical: theme.spacing[2], gap: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { alignItems: "flex-end" },
}));
