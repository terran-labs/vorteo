import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import type {
  UpdateChannel,
  UpdateMode,
  UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { formatTimeAgo } from "@/utils/time";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "@/execution-installation/client";
import { useInstallationOwnerClient } from "@/execution-installation/panel";
import { InstallationUpgradeDetails } from "@/execution-installation/installation-upgrade-card";
import {
  activeUpgrade,
  latestFinishedUpgrade,
  supportsUpdatePolicy,
  upgradeApprovalText,
  upgradeOffer,
} from "@/execution-installation/installation-upgrades-model";
import {
  useInstallationUpgradeActions,
  useInstallationUpgradeStatus,
} from "@/execution-installation/use-installation-upgrades";
import type { VortonUpdate } from "./check";

const MODE_OPTIONS: SegmentedControlOption<UpdateMode>[] = [
  { value: "manual", label: "Ask me", testID: "installation-update-mode-manual" },
  {
    value: "automatic",
    label: "Install automatically",
    testID: "installation-update-mode-automatic",
  },
];

const CHANNEL_OPTIONS: SegmentedControlOption<UpdateChannel>[] = [
  { value: "stable", label: "Stable", testID: "installation-update-channel-stable" },
  { value: "beta", label: "Beta", testID: "installation-update-channel-beta" },
];

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
  const policy = supportsUpdatePolicy(status.data);
  return (
    <View style={[styles.body, settingsStyles.rowBorder]} testID="installation-upgrade-section">
      {policy ? <UpdatePolicyControls client={client} status={status.data} /> : null}
      {offer ? (
        <>
          <Text style={styles.hint}>
            {`System services can update to ${offer} after you review it. ${upgradeApprovalText(status.data.container, policy, status.data.upgrades)}`}
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
        <InstallationUpgradeDetails client={client} upgrade={shown} status={status.data} />
      ) : null}
      <SettingsStatusLine message={create.error ? toErrorMessage(create.error) : null} />
    </View>
  );
}

/** Update mode, channel and the coordinator's last check, for coordinators with a policy. */
function UpdatePolicyControls({
  client,
  status,
}: {
  client: InstallationClient;
  status: UpgradeStatus;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const { changePolicy, check } = useInstallationUpgradeActions(client);
  const setMode = useCallback((mode: UpdateMode) => changePolicy.mutate({ mode }), [changePolicy]);
  const setChannel = useCallback(
    (channel: UpdateChannel) => changePolicy.mutate({ channel }),
    [changePolicy],
  );
  const checkNow = useCallback(() => check.mutate(), [check]);
  const policy = status.policy;
  if (!policy) return null;
  const error = changePolicy.error ?? check.error;
  return (
    <View style={styles.policy} testID="installation-update-policy">
      <View style={styles.control}>
        <View style={styles.controlText}>
          <Text style={settingsStyles.rowTitle}>Updates</Text>
          <Text style={styles.hint}>
            Automatic installs wait for current work to finish. Security fixes follow the same
            choice.
          </Text>
        </View>
        <SegmentedControl
          options={MODE_OPTIONS}
          value={policy.mode}
          onValueChange={setMode}
          size={controlSize}
          testID="installation-update-mode"
        />
      </View>
      <View style={styles.control}>
        <View style={styles.controlText}>
          <Text style={settingsStyles.rowTitle}>Channel</Text>
          <Text style={styles.hint}>Beta gets releases first.</Text>
        </View>
        <SegmentedControl
          options={CHANNEL_OPTIONS}
          value={policy.channel}
          onValueChange={setChannel}
          size={controlSize}
          testID="installation-update-channel"
        />
      </View>
      <View style={styles.control}>
        <Text style={[styles.hint, styles.controlText]} testID="installation-update-last-check">
          {lastCheckText(status)}
        </Text>
        <Button
          variant="outline"
          size={controlSize}
          onPress={checkNow}
          loading={check.isPending}
          disabled={check.isPending || changePolicy.isPending}
          testID="installation-update-check"
        >
          Check now
        </Button>
      </View>
      <SettingsStatusLine message={error ? toErrorMessage(error) : null} />
    </View>
  );
}

function lastCheckText(status: UpgradeStatus): string {
  const check = status.check;
  if (!check?.checkedAt) return "The installation has not checked for updates yet.";
  const when = `Last checked ${formatTimeAgo(new Date(check.checkedAt))}`;
  if (check.error) return `${when}. The check failed: ${check.error}`;
  if (check.latest) return `${when}. ${check.latest.release} is available.`;
  return `${when}. Vorteo is up to date.`;
}

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  policy: { gap: theme.spacing[3], paddingBottom: theme.spacing[1] },
  control: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  controlText: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  hint: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
