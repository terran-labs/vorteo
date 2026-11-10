import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

// Host-wide and applied live. Off by default because each review resumes a whole provider session.
export function BlockedWorkReviewCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "blockedWorkReviewSetting");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig({ blockedWorkReview: next });
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate(next);
    },
    [mutation],
  );

  if (!isConnected || !isSupported || !config) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-blocked-work-review-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <View style={styles.titleRow}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.agents.blockedWorkReview.title")}
            </Text>
            <SettingsInfoTip
              title={t("settings.host.agents.blockedWorkReview.title")}
              info={t("settings.host.agents.blockedWorkReview.info")}
            />
          </View>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.agents.blockedWorkReview.hint")}
          </Text>
          {mutation.error ? (
            <Text style={settingsStyles.rowError} testID="host-page-blocked-work-review-error">
              {mutation.error.message}
            </Text>
          ) : null}
        </View>
        <Switch
          value={config.blockedWorkReview === true}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel={t("settings.host.agents.blockedWorkReview.title")}
          testID="host-page-blocked-work-review-switch"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
