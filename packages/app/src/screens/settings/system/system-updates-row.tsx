import { useInstallationOwnerClient } from "@/execution-installation/panel";
import {
  useInstallationUpgradeStatus,
  useInstallationUpgradeActions,
} from "@/execution-installation/use-installation-upgrades";
import { supportsUpdatePolicy } from "@/execution-installation/installation-upgrades-model";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
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
  const owner = useInstallationOwnerClient();
  const installation = useInstallationUpgradeStatus(owner);
  const actions = useInstallationUpgradeActions(owner);
  const policy = Boolean(owner && supportsUpdatePolicy(installation.data));
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
    if (policy)
      void actions.check.mutateAsync().catch((error) => toast.error(toErrorMessage(error)));
    else update.checkNow();
    if (app.isDesktopApp) void app.checkForUpdates();
  }, [update, app, policy, actions.check, toast]);
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
  const status = updateStatusText(
    update.data,
    policy ? installation.data : null,
    app.isDesktopApp ? app.statusText : null,
  );
  return (
    <View testID="system-updates-row" style={settingsStyles.card}>
      <View style={styles.row}>
        <View style={styles.description}>
          <Text style={settingsStyles.rowTitle}>Updates</Text>
          <Text style={styles.status}>{status}</Text>
        </View>
        <Button
          onPress={check}
          disabled={app.isChecking || update.isFetching || actions.check.isPending}
          testID="system-check-updates"
        >
          Check
        </Button>
        <Button
          variant="ghost"
          onPress={toggle}
          accessibilityState={accessibilityState}
          // React Native Web drops `accessibilityState.expanded`.
          aria-expanded={expanded}
        >
          Details
        </Button>
      </View>
      {expanded ? (
        <ScrollView style={styles.details} contentContainerStyle={styles.body}>
          {!policy ? (
            <SelectField
              label="Release channel"
              value={settings.releaseChannel}
              selectedDisplay={display}
              options={channels}
              onChange={changeChannel}
              placeholder="Choose channel"
              emptyText="No channels"
            />
          ) : null}
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
function updateStatusText(
  update: ReturnType<typeof useVortonUpdate>["data"],
  installation: ReturnType<typeof useInstallationUpgradeStatus>["data"],
  appStatus: string | null,
) {
  let message = "Check for updates";
  if (update?.status === "available")
    message = `Vorteo ${update.latestRelease ?? "update"} available`;
  if (update?.status === "current") message = "Vorteo is up to date";
  if (installation)
    message =
      installation.check?.error ??
      (installation.check?.latest
        ? `Vorteo ${installation.check.latest.release} available`
        : "Installation updates follow its saved channel");
  return appStatus ? `${appStatus}. ${message}` : message;
}

const styles = StyleSheet.create((theme) => ({
  // One compact line like the Host and Dev rows; it wraps on narrow panes.
  row: {
    minHeight: 44,
    paddingVertical: theme.spacing[2],
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  description: { flexGrow: 1, flexShrink: 1, flexBasis: 240, gap: theme.spacing[0.5] },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  details: { height: 500 },
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
}));
