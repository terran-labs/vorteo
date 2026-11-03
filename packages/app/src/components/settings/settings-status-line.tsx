import { Text, View } from "react-native";
import { settingsStyles } from "@/styles/settings";

/** Always reserves one line, including when there is no status to announce. */
export function SettingsStatusLine({ message }: { message?: string | null }) {
  return (
    <View style={reservedLayout1}>
      <Text numberOfLines={1} accessibilityLiveRegion="polite" style={settingsStyles.rowHint}>
        {message ?? " "}
      </Text>
    </View>
  );
}

const reservedLayout1 = { height: 24, justifyContent: "center", overflow: "hidden" } as const;
