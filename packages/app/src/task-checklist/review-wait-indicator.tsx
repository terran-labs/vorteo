import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Hourglass } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_ALERT_SIZE } from "@/utils/status-indicator-geometry";
import { reviewWaitSummary } from "./review-wait";

// Working blue, the color of the busy ring: the work is still moving, just not here.
const waitingColor = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? theme.colors.foreground,
});
const managedColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const ThemedHourglass = withUnistyles(Hourglass);

/** Takes the row's status slot while its idle thread waits on a Review item. */
export function ReviewWaitIndicator({
  tasks,
  muted = false,
  slotStyle,
}: {
  tasks: readonly TodoEntry[];
  muted?: boolean;
  slotStyle: StyleProp<ViewStyle>;
}) {
  const summary = reviewWaitSummary(tasks);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <View
          style={slotStyle}
          accessible
          tabIndex={0}
          accessibilityLabel={`${summary.heading}: ${summary.rows.map((row) => row.title).join(", ")}`}
          testID="workspace-status-indicator-review"
        >
          <ThemedHourglass
            size={STATUS_INDICATOR_ALERT_SIZE}
            strokeWidth={2.25}
            uniProps={muted ? managedColor : waitingColor}
          />
        </View>
      </TooltipTrigger>
      <TooltipContent maxWidth={360}>
        <View style={styles.content}>
          <Text style={styles.heading}>{summary.heading}</Text>
          {summary.rows.map((row) => (
            <View key={row.key}>
              <Text style={styles.title}>{row.title}</Text>
              {row.detail ? <Text style={styles.detail}>{row.detail}</Text> : null}
            </View>
          ))}
          {summary.more > 0 ? <Text style={styles.detail}>and {summary.more} more</Text> : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[1.5] },
  heading: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
