import { useToast } from "@/contexts/toast-context";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { ActionFooter } from "@/components/ui/action-footer";
import { useMaintenanceTask } from "@/execution-installation/use-maintenance-task";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";

import { UPSTREAM_SYNC, UPSTREAM_UPDATE_PROMPT, upstreamSyncStatus } from "./upstream";

export function UpstreamUpdatesSection() {
  return <UpstreamUpdatesContent />;
}

function UpstreamUpdatesContent() {
  const { t, i18n } = useTranslation();
  const prepareTask = useMaintenanceTask();
  const prepareMerge = useCallback(() => prepareTask(UPSTREAM_UPDATE_PROMPT), [prepareTask]);
  const [now, setNow] = useState(Date.now);
  const [showPrompt, setShowPrompt] = useState(false);
  // Settings may stay open across the weekly boundary or a device sleep.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const toast = useToast();
  const copy = useMutation({
    onSuccess: () => toast.show(t("settings.about.upstreamUpdates.copied")),
    onError: () => toast.error(t("settings.about.upstreamUpdates.copyFailed")),
    mutationFn: async () => {
      const copied = await Clipboard.setStringAsync(UPSTREAM_UPDATE_PROMPT);
      if (!copied) throw new Error("Clipboard write was declined");
    },
  });
  const { mutate } = copy;
  const copyPrompt = useCallback(() => mutate(), [mutate]);
  const togglePrompt = useCallback(() => setShowPrompt((shown) => !shown), []);
  const sync = upstreamSyncStatus(UPSTREAM_SYNC, now);
  const overdue = sync.status === "overdue";
  let lastMerge = t("settings.about.upstreamUpdates.unknown");
  if (sync.status !== "unknown") {
    const date = new Date(sync.record.mergedAt).toLocaleDateString(i18n.language, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    lastMerge = t("settings.about.upstreamUpdates.lastMerge", { date });
  }
  return (
    <SettingsSection
      title={t("settings.about.upstreamUpdates.title")}
      testID="upstream-updates-section"
    >
      <View style={[settingsStyles.card, overdue && styles.overdue]} testID="upstream-updates-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle} testID="upstream-merge-date">
              {lastMerge}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.about.upstreamUpdates.buildRecord")}
            </Text>
          </View>
        </View>
        <SettingsStatusLine
          testID="upstream-update-overdue"
          message={overdue ? t("settings.about.upstreamUpdates.overdue") : null}
        />
        <View style={styles.content}>
          <Text style={settingsStyles.rowHint}>
            Review and edit the suggested host task before sending it. Preparing a draft does not
            start an update or merge.
          </Text>
          <ActionFooter style={styles.actions}>
            <Button size="md" onPress={prepareMerge} testID="prepare-upstream-task">
              Prepare host merge task
            </Button>
            <Button
              variant="outline"
              size="md"
              onPress={copyPrompt}
              loading={copy.isPending}
              testID="copy-upstream-prompt"
            >
              {t("settings.about.upstreamUpdates.copy")}
            </Button>
            <Button
              variant="ghost"
              size="md"
              onPress={togglePrompt}
              testID="toggle-upstream-prompt"
            >
              {t(`settings.about.upstreamUpdates.${showPrompt ? "hidePrompt" : "showPrompt"}`)}
            </Button>
          </ActionFooter>
          {showPrompt && (
            <Text selectable style={styles.prompt} testID="upstream-host-prompt">
              {UPSTREAM_UPDATE_PROMPT}
            </Text>
          )}
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  overdue: { borderColor: theme.colors.statusWarning },
  content: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[3],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  prompt: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
