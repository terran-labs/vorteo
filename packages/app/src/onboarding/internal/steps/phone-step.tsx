import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AppleIcon } from "@/components/icons/apple-icon";
import { GooglePlayIcon } from "@/components/icons/google-play-icon";
import { SettingsCard, SettingsDetailRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAddHost } from "@/hosts/add-host";
import {
  CONNECTIVITY_DOCS_URL,
  TAILSCALE_DOCS_URL,
} from "@/desktop/components/pair-device-section";
import { ICON_SIZE } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const APP_STORE_URL = "https://apps.apple.com/app/paseo-pocket-engineer/id6758887924";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=sh.paseo";

// Button calls a one-argument function with its icon colour, so the Apple mark follows the theme.
const renderAppleIcon = (color: string) => <AppleIcon color={color} size={ICON_SIZE.sm} />;
const renderGooglePlayIcon = () => <GooglePlayIcon size={ICON_SIZE.sm} />;

function openUrl(url: string) {
  void openExternalUrl(url).catch(console.error);
}

// Under the pending owner decision in onboarding/index.ts, retain only Vorteo's supported
// direct Add host flow here. Enabling setup must never revive retired QR/link pairing.
export function PhoneStep(_props: { serverId: string }) {
  const { t } = useTranslation();
  const openAppStore = useCallback(() => openUrl(APP_STORE_URL), []);
  const openPlayStore = useCallback(() => openUrl(PLAY_STORE_URL), []);
  const openTailscaleDocs = useCallback(() => openUrl(TAILSCALE_DOCS_URL), []);
  const openAddHost = useAddHost({ method: "direct" });
  const recommendedBadge = useMemo(
    () => (
      <StatusBadge
        size="xs"
        variant="success"
        label={t("onboarding.setup.steps.phone.recommended")}
      />
    ),
    [t],
  );
  const docsLink = useMemo(
    () => ({
      href: CONNECTIVITY_DOCS_URL,
      label: t("onboarding.setup.steps.phone.connectDocs"),
      accessibilityLabel: t("onboarding.setup.steps.phone.openConnectDocs"),
    }),
    [t],
  );

  return (
    <View style={styles.container}>
      <View style={styles.storeLinks}>
        <Button variant="outline" leftIcon={renderAppleIcon} onPress={openAppStore}>
          {t("onboarding.setup.steps.phone.appStore")}
        </Button>
        <Button variant="outline" leftIcon={renderGooglePlayIcon} onPress={openPlayStore}>
          {t("onboarding.setup.steps.phone.googlePlay")}
        </Button>
      </View>
      <SettingsSection title={t("onboarding.setup.steps.phone.connectTitle")} link={docsLink}>
        <SettingsCard>
          <SettingsDetailRow
            label={t("settings.addHost")}
            labelAccessory={recommendedBadge}
            hint={t("pairing.connectionMethods.direct.description")}
            onPress={openAddHost}
            testID="onboarding-phone-add-host"
          />
          <SettingsDetailRow
            label={t("onboarding.setup.steps.phone.tailscale.title")}
            hint={t("onboarding.setup.steps.phone.tailscale.hint")}
            summary={t("onboarding.setup.steps.phone.connectDocs")}
            onPress={openTailscaleDocs}
            external
            testID="onboarding-phone-tailscale"
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[6],
  },
  storeLinks: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
