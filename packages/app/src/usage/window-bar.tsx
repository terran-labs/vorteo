import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  formatDisplayPct,
  formatProviderUsageLabel,
  formatResetLabel,
  formatResetTime,
  formatRunsOutLabel,
} from "./format";
import { UsageMeter } from "./meter";
import { displayPercent } from "./model";
import { UsageResetLine } from "./reset-line";
import type { UsageDisplayAs } from "./preferences";
import { windowTone } from "./tone";
import type { UsageWindow } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

/** One quota window: its label, value, meter and reset line. */
export function UsageWindowBar({
  window,
  displayAs,
  retained = false,
}: {
  retained?: boolean;
  window: UsageWindow;
  displayAs: UsageDisplayAs;
}) {
  const { t, i18n } = useTranslation();
  const shownPct = displayPercent(window, displayAs);
  const tone = windowTone(window);

  const now = useRelativeTimeTick({ enabled: window.runsOutAt != null || window.resetsAt != null });
  const isAtRisk =
    window.runsOutAt != null &&
    window.shortfallPct != null &&
    (!retained || Date.parse(window.runsOutAt) > now);
  const countdown = isAtRisk
    ? formatRunsOutLabel(window.runsOutAt, now, t)
    : formatResetLabel(window.resetsAt, retained, now, t);
  // The exact time belongs to the reset; beside a runs-out warning it would read as the moment
  // the quota runs out.
  const exactTime = isAtRisk ? null : formatResetTime(window.resetsAt, now, t);

  const value =
    shownPct != null ? formatDisplayPct(shownPct, displayAs, i18n.resolvedLanguage, t) : "—";
  return (
    <View style={styles.row}>
      <View style={styles.labelRow}>
        <Text style={styles.label} numberOfLines={1}>
          {formatProviderUsageLabel(window.id, window.label, t)}
        </Text>
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <UsageMeter percent={shownPct ?? 0} tone={tone} />
      <UsageResetLine countdown={countdown} exactTime={exactTime} atRisk={isAtRisk} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { gap: 3, paddingVertical: theme.spacing[1.5] },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  value: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
