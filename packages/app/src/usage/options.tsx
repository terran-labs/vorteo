import { View } from "react-native";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsRow,
  SettingsSwitch,
} from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { usageCopy } from "./copy";
import { useUsageDisplay, type UsageDisplay } from "./display";
import { useUsageSetting } from "./setting";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";

import type { UsageDisplayAs } from "./preferences";

const DISPLAY_AS_OPTIONS: SegmentedControlOption<UsageDisplayAs>[] = [
  { value: "used", label: usageCopy.displayUsed, testID: "usage-display-used" },
  { value: "remaining", label: usageCopy.displayRemaining, testID: "usage-display-remaining" },
];

export function UsageOptions({
  display: providedDisplay,
  serverId = null,
}: {
  display?: UsageDisplay;
  serverId?: string | null;
}) {
  const { display: defaultDisplay } = useUsageDisplay([]);
  const display = providedDisplay ?? defaultDisplay;
  const setting = useUsageSetting(serverId);
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.section}>
      <SettingsCard>
        <SettingsCollapsibleRow label={usageCopy.options} testID="usage-options">
          {setting.error ? <Alert variant="error" description={setting.error.message} /> : null}
          {setting.supported ? (
            <SettingsSwitch
              label={t("providerUsage.checkUsage")}
              disabled={!setting.ready}
              value={setting.enabled}
              onValueChange={setting.setEnabled}
            />
          ) : null}
          <SettingsRow label={usageCopy.displayAs}>
            <SegmentedControl
              options={DISPLAY_AS_OPTIONS}
              value={display.displayAs}
              onValueChange={display.setDisplayAs}
              size="sm"
              testID="usage-display-as"
            />
          </SettingsRow>
        </SettingsCollapsibleRow>
      </SettingsCard>
    </View>
  );
}
