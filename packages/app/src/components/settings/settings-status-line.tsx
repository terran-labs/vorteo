import { useMemo } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { settingsStyles } from "@/styles/settings";

/**
 * Reserve two scaled lines, including when there is no status to announce. The text node keeps
 * the full message for assistive technology; numberOfLines only clips it visually. A copied
 * accessibilityLabel would also make the message match getByLabel queries for nearby fields.
 */
export function SettingsStatusLine({
  message,
  testID,
}: {
  message?: string | null;
  testID?: string;
}) {
  const { fontScale } = useWindowDimensions();
  const container = useMemo(
    () => ({ minHeight: STATUS_LINE_HEIGHT * 2 * fontScale, justifyContent: "center" as const }),
    [fontScale],
  );
  return (
    <View style={container}>
      <Text
        testID={message ? testID : undefined}
        numberOfLines={2}
        accessibilityLiveRegion={message ? "polite" : undefined}
        style={[settingsStyles.rowHint, lineStyle]}
      >
        {message || " "}
      </Text>
    </View>
  );
}
const STATUS_LINE_HEIGHT = 20;
const lineStyle = { lineHeight: STATUS_LINE_HEIGHT, marginTop: 0 };
