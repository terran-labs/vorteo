import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UpgradeStatus } from "@getpaseo/protocol/installation-upgrades";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import type { InstallationClient } from "@/execution-installation/client";
import {
  UpgradeAcknowledgeButton,
  UpgradeDecisionButtons,
  UpgradeReleaseNotes,
} from "@/execution-installation/installation-upgrade-card";
import {
  installationUpdateEntry,
  releaseVersionLabel,
  upgradeFailureDetail,
  upgradeStepRows,
  type InstallationUpdateEntry,
} from "@/execution-installation/installation-upgrades-model";
import { useInstallationOwnerClient } from "@/execution-installation/panel";
import { useInstallationUpgradeStatus } from "@/execution-installation/use-installation-upgrades";

export interface InstallationUpdateState {
  client: InstallationClient;
  status: UpgradeStatus;
  entry: InstallationUpdateEntry;
}

/**
 * The installation update to show beside open questions. Null while owner controls are
 * locked, since Settings explains that case.
 */
export function useInstallationUpdate(): InstallationUpdateState | null {
  const client = useInstallationOwnerClient();
  const status = useInstallationUpgradeStatus(client);
  const entry = installationUpdateEntry(status.data);
  if (!client || !status.data || !entry) return null;
  return { client, status: status.data, entry };
}

/** An update question, a finished automatic update, or a compact progress line. */
export function InstallationUpdateItem({ client, status, entry }: InstallationUpdateState) {
  const { upgrade } = entry;
  const version = releaseVersionLabel(upgrade.release);
  return (
    <View
      style={[styles.item, taskCardStyles.proseInset]}
      testID={`global-installation-update-${entry.kind}`}
    >
      {entry.kind === "question" ? (
        <>
          <Text style={styles.title}>{`Install Vorteo ${version}?`}</Text>
          <Text style={styles.meta}>{upgrade.release}</Text>
          <UpgradeReleaseNotes upgrade={upgrade} status={status} />
          <UpgradeDecisionButtons client={client} upgrade={upgrade} status={status} />
        </>
      ) : null}
      {entry.kind === "notice" ? (
        <>
          <Text style={styles.title}>
            {upgrade.status === "succeeded"
              ? `Vorteo updated to ${version} automatically`
              : `Automatic update to ${version} failed: ${upgradeFailureDetail(upgrade)}`}
          </Text>
          <UpgradeAcknowledgeButton client={client} upgrade={upgrade} />
        </>
      ) : null}
      {entry.kind === "progress" ? (
        <>
          <Text style={styles.muted}>{progressText(entry, version)}</Text>
          <UpgradeDecisionButtons client={client} upgrade={upgrade} status={status} />
        </>
      ) : null}
    </View>
  );
}

function progressText(entry: InstallationUpdateEntry, version: string): string {
  const { upgrade } = entry;
  const step = upgradeStepRows(upgrade).find((row) => row.status === "running");
  if (step) return `Installing Vorteo ${version}: ${step.detail || step.label}`;
  if (upgrade.status === "approved" && upgrade.restart === "after-work")
    return `Vorteo ${version} installs once current work finishes.`;
  return `Installing Vorteo ${version}`;
}

const styles = StyleSheet.create((theme) => ({
  item: { gap: theme.spacing[1.5], paddingVertical: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  meta: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
}));
