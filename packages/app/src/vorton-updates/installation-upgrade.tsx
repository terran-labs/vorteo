import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { useInstallationOwnerClient } from "@/execution-installation/panel";
import { InstallationUpgradeDetails } from "@/execution-installation/installation-upgrade-card";
import {
  activeUpgrade,
  latestFinishedUpgrade,
  upgradeApprovalText,
  upgradeOffer,
} from "@/execution-installation/installation-upgrades-model";
import {
  useInstallationUpgradeActions,
  useInstallationUpgradeStatus,
} from "@/execution-installation/use-installation-upgrades";
import type { VortonUpdate } from "./check";

/**
 * Release upgrades run by the installation coordinator. Renders nothing when controls are
 * locked or the coordinator predates upgrades; the agent update task remains for those cases.
 */
export function InstallationUpgradeSection({ update }: { update: VortonUpdate | undefined }) {
  const client = useInstallationOwnerClient();
  const status = useInstallationUpgradeStatus(client);
  const { create } = useInstallationUpgradeActions(client);
  const offer = upgradeOffer({
    status: status.data,
    latestRelease: update?.latestRelease,
    updateAvailable: update?.status === "available",
  });
  const start = useCallback(() => {
    if (offer) create.mutate(offer);
  }, [create, offer]);
  if (!client || !status.data?.available) return null;
  const shown = activeUpgrade(status.data) ?? latestFinishedUpgrade(status.data);
  return (
    <View style={[styles.body, settingsStyles.rowBorder]} testID="installation-upgrade-section">
      {offer ? (
        <>
          <Text style={styles.hint}>
            {`System services can update to ${offer} after you review it. ${upgradeApprovalText(status.data.container)}`}
          </Text>
          <View style={styles.actions}>
            <Button
              size="md"
              onPress={start}
              loading={create.isPending}
              disabled={create.isPending}
              testID="installation-upgrade-start"
            >
              {`Update to ${offer}`}
            </Button>
          </View>
        </>
      ) : null}
      {shown ? (
        <InstallationUpgradeDetails
          client={client}
          upgrade={shown}
          hasDev={status.data.container}
        />
      ) : null}
      <SettingsStatusLine message={create.error ? toErrorMessage(create.error) : null} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  hint: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
