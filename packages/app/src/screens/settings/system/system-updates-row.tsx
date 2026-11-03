import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { useSettings } from "@/hooks/use-settings";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { useVortonUpdate } from "@/vorton-updates/use-update";
import { VortonUpdatesSection } from "@/vorton-updates/section";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { settingsStyles } from "@/styles/settings";
const channels = [
  { id: "stable", value: "stable", label: "Stable" },
  { id: "beta", value: "beta", label: "Beta" },
];
/** App and installation releases share one stable row; receipts stay behind an explicit disclosure. */
export function SystemUpdatesRow() {
  const app = useDesktopAppUpdater();
  const update = useVortonUpdate();
  const { settings, updateSettings } = useSettings();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const changeChannel = useCallback(
    (value: string) => {
      if (value === "stable" || value === "beta")
        void updateSettings({ releaseChannel: value }).catch((error) =>
          toast.error(toErrorMessage(error)),
        );
    },
    [updateSettings, toast],
  );
  const display = useMemo(
    () => ({ label: settings.releaseChannel === "beta" ? "Beta" : "Stable" }),
    [settings.releaseChannel],
  );
  const check = useCallback(() => {
    update.checkNow();
    if (app.isDesktopApp) void app.checkForUpdates();
  }, [update, app]);
  const install = useCallback(async () => {
    try {
      if (
        await confirmDialog({
          title: "Update the app?",
          message: "The app closes and reopens after installing the update.",
          confirmLabel: "Update app",
        })
      )
        await app.installUpdate();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }, [app, toast]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  let status = "Check for updates";
  if (update.data?.status === "available")
    status = `Vorteo ${update.data.latestRelease ?? "update"} available`;
  if (update.data?.status === "current") status = "Vorteo is up to date";
  if (app.isDesktopApp) status = `${app.statusText}. ${status}`;
  return (
    <View testID="system-updates-row" style={settingsStyles.card}>
      <View style={styles.row}>
        <View style={styles.description}>
          <Text style={settingsStyles.rowTitle}>Updates</Text>
          <SettingsStatusLine message={status} />
        </View>
        <Button
          onPress={check}
          disabled={app.isChecking || update.isFetching}
          testID="system-check-updates"
        >
          Check
        </Button>
        <Button variant="ghost" onPress={toggle} accessibilityState={accessibilityState}>
          Details
        </Button>
      </View>
      {expanded ? (
        <ScrollView style={styles.details} contentContainerStyle={styles.body}>
          <SelectField
            label="Release channel"
            value={settings.releaseChannel}
            selectedDisplay={display}
            options={channels}
            onChange={changeChannel}
            placeholder="Choose channel"
            emptyText="No channels"
          />
          {app.isDesktopApp ? (
            <>
              <SettingsStatusLine message={app.errorMessage ?? app.statusText} />
              <Button
                onPress={install}
                disabled={!app.availableUpdate?.readyToInstall || app.isInstalling}
              >
                Update app
              </Button>
            </>
          ) : null}
          <VortonUpdatesSection />
        </ScrollView>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    height: 88,
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  description: { flex: 1, minWidth: 0 },
  details: { height: 500 },
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
}));
