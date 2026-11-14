import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import {
  SETTINGS_RESET_GROUPS,
  isSettingsGroupDefault,
  useAppSettings,
  useResetSettingsGroup,
  type SettingsResetGroup,
} from "@/hooks/use-settings";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A section header's Reset: asks, then restores the group's device settings to their defaults.
 * It never disables itself, so focus can return to it after the confirmation closes (the web
 * confirm blurs the page); a polite live region says what happened.
 */
export function ResetGroupButton({
  group,
  onReset,
}: {
  group: SettingsResetGroup;
  /** Runs after a confirmed reset, for drafts the section keeps outside settings. */
  onReset?: () => void;
}) {
  const { settings, updateSettings } = useAppSettings();
  const reset = useResetSettingsGroup(updateSettings);
  const button = useRef<View>(null);
  const [status, setStatus] = useState("");
  const { title } = SETTINGS_RESET_GROUPS[group];
  const atDefaults = isSettingsGroupDefault(settings, group);
  const press = useCallback(() => {
    void (async () => {
      if (atDefaults) {
        setStatus(`${capitalize(title)} already uses the defaults`);
        return;
      }
      const done = await reset(group);
      // On web a View ref is its DOM element.
      if (isWeb) (button.current as unknown as HTMLElement | null)?.focus();
      if (!done) return;
      onReset?.();
      setStatus(`${capitalize(title)} reset to defaults`);
    })();
  }, [atDefaults, group, onReset, reset, title]);
  return (
    <View style={styles.wrapper}>
      <Button
        ref={button}
        variant="ghost"
        size="sm"
        onPress={press}
        accessibilityLabel={`Reset ${title} to defaults`}
        testID={`settings-reset-${group}`}
      >
        Reset
      </Button>
      <Text accessibilityLiveRegion="polite" style={styles.visuallyHidden}>
        {status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: "relative" },
  visuallyHidden: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
});
