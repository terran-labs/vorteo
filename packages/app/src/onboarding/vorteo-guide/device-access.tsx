import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { SvgXml } from "react-native-svg";
import { useMutation } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { useFetchQuery } from "@/data/query";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { useAddHost } from "@/hosts/add-host";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import type { VorteoGuideModel } from "./model";

export function DeviceAccess({ model }: { model: VorteoGuideModel }) {
  const { t } = useTranslation();
  // origin is validated against this installation by readExecutionInstallation.
  // Do not encode the current location: it can contain a private workspace or login query.
  const origin = readExecutionInstallation()?.origin ?? null;
  const qr = useFetchQuery({
    queryKey: ["installation-address-qr", origin],
    dataShape: "value",
    enabled: origin !== null,
    queryFn: () =>
      QRCode.toString(origin ?? "", { type: "svg", errorCorrectionLevel: "M", margin: 1 }),
    staleTimeMs: Infinity,
    retry: false,
  });
  const copy = useMutation({ mutationFn: () => Clipboard.setStringAsync(origin ?? "") });
  const copyAddress = useCallback(() => copy.mutate(), [copy]);
  const addHost = useAddHost();
  const openAddHost = useCallback(() => {
    void model.pause().then(addHost);
  }, [model, addHost]);
  return (
    <View style={styles.content}>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.deviceHint")}</Text>
      <Text selectable style={settingsStyles.rowTitle}>
        {origin}
      </Text>
      <View style={styles.qr}>
        {qr.data ? (
          <SvgXml
            xml={qr.data}
            width="100%"
            height="100%"
            accessibilityRole="image"
            accessibilityLabel={t("vorteoSetup.urlQr")}
          />
        ) : null}
      </View>
      {qr.error ? <Alert variant="warning" description={t("vorteoSetup.qrFailed")} /> : null}
      <Button variant="outline" onPress={copyAddress} loading={copy.isPending}>
        {copy.isSuccess ? t("vorteoSetup.copied") : t("vorteoSetup.copyAddress")}
      </Button>
      {copy.error ? <Alert variant="error" description={toErrorMessage(copy.error)} /> : null}
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.deviceNetwork")}</Text>
      <SettingsCard>
        <SettingsRow label={t("vorteoSetup.addHost")} hint={t("vorteoSetup.addHostHint")}>
          <Button variant="outline" onPress={openAddHost}>
            {t("vorteoSetup.addHost")}
          </Button>
        </SettingsRow>
      </SettingsCard>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.cliHint")}</Text>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.finishHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  qr: { width: 200, maxWidth: "100%", aspectRatio: 1, alignSelf: "center" },
}));
