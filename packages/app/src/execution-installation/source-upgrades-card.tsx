import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SourceUpgrade } from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import { useSourceUpgradeActions, useSourceUpgrades } from "./use-installation-upgrades";

const STATUS: Record<SourceUpgrade["status"], { label: string; variant: StatusBadgeVariant }> = {
  pending: { label: "Waiting", variant: "warning" },
  approved: { label: "Approved", variant: "warning" },
  running: { label: "Installing", variant: "warning" },
  succeeded: { label: "Installed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  rejected: { label: "Rejected", variant: "muted" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

const CONFIRMATION =
  "Installs this commit on the Host and Dev. Current work finishes first; then the Host and Dev restart. You can roll the Host back for 24 hours afterwards.";

/** How long a finished source upgrade stays visible here. */
const RECENT_MS = 24 * 60 * 60_000;

/**
 * Stable source upgrades, including those Builds requested. A request the full maintenance
 * grant approved says when it starts; Cancel stops it until it is running.
 */
export function SourceUpgradesCard({ client }: { client: InstallationClient | null }) {
  const upgrades = (useSourceUpgrades(client).data?.upgrades ?? []).filter(
    (upgrade) =>
      ["pending", "approved", "running"].includes(upgrade.status) ||
      Date.now() - Date.parse(upgrade.createdAt) < RECENT_MS,
  );
  if (!client || upgrades.length === 0) return null;
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="source-upgrades-card">
      <Text style={settingsStyles.rowTitle}>Source upgrades</Text>
      {upgrades.map((upgrade) => (
        <SourceUpgradeRow
          key={`${upgrade.id}:${upgrade.revision}`}
          client={client}
          upgrade={upgrade}
        />
      ))}
    </View>
  );
}

function SourceUpgradeRow({
  client,
  upgrade,
}: {
  client: InstallationClient;
  upgrade: SourceUpgrade;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const decide = useSourceUpgradeActions(client);
  const approve = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: `Install ${upgrade.sourceCommit.slice(0, 12)}?`,
      message: CONFIRMATION,
      confirmLabel: "Install",
      destructive: true,
    });
    if (confirmed) decide.mutate({ upgrade, decision: "approve-after-work" });
  }, [decide, upgrade]);
  const pressApprove = useCallback(() => void approve(), [approve]);
  const reject = useCallback(
    () => decide.mutate({ upgrade, decision: "reject" }),
    [decide, upgrade],
  );
  const cancel = useCallback(
    () => decide.mutate({ upgrade, decision: "cancel" }),
    [decide, upgrade],
  );
  const pending = upgrade.status === "pending";
  const canCancel = pending || upgrade.status === "approved";
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.key} selectable>
          {upgrade.rollbackOf ? "Roll back to " : ""}
          {upgrade.sourceCommit.slice(0, 12)}
        </Text>
        <StatusBadge
          label={STATUS[upgrade.status].label}
          variant={STATUS[upgrade.status].variant}
        />
      </View>
      <Text style={styles.text}>
        {upgrade.reason} Requested by {upgrade.requestedBy}.
      </Text>
      <Text style={styles.text}>{upgrade.detail}</Text>
      {pending || canCancel ? (
        <View style={styles.actions}>
          {pending ? (
            <Button
              size={controlSize}
              onPress={pressApprove}
              loading={decide.isPending}
              disabled={decide.isPending}
              testID="source-upgrade-approve"
            >
              Install
            </Button>
          ) : null}
          {pending ? (
            <Button
              variant="outline"
              size={controlSize}
              onPress={reject}
              disabled={decide.isPending}
              testID="source-upgrade-reject"
            >
              Reject
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="outline"
              size={controlSize}
              onPress={cancel}
              disabled={decide.isPending}
              testID="source-upgrade-cancel"
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
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
