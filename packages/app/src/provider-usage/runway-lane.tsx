import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DayTick, Runway, RunwayState } from "./runway";

/** Day labels closer than this to either end would collide with "Now" or be clipped. */
const LABEL_MARGIN = 0.13;

function pct(fraction: number): `${number}%` {
  return `${Math.max(0, Math.min(100, fraction * 100))}%`;
}

/** A week ahead on one account: a thin bar whose stretches show what work can draw from. */
export const RunwayLane = memo(function RunwayLane({
  runway,
  label,
  testID,
}: {
  runway: Runway;
  label: string;
  testID?: string;
}) {
  return (
    <View style={styles.lane} accessibilityRole="image" accessibilityLabel={label} testID={testID}>
      <View style={styles.track}>
        {runway.segments.map((segment, index) => (
          <View
            key={`${segment.state}-${segment.start}`}
            style={[
              styles.segment,
              segmentStyle(segment.state),
              {
                left: pct(segment.start),
                width: pct(segment.end - segment.start),
                // Earlier stretches paint on top, so a short one at now keeps its minimum width.
                zIndex: runway.segments.length - index,
              },
            ]}
            testID={testID ? `${testID}-${segment.state}` : undefined}
          />
        ))}
      </View>
      {runway.resets.map((at) => (
        <View
          key={at}
          style={[styles.notch, { left: pct(at) }]}
          testID={testID ? `${testID}-reset` : undefined}
        />
      ))}
    </View>
  );
});

function segmentStyle(state: RunwayState) {
  switch (state) {
    case "capacity":
      return styles.capacity;
    case "low":
      return styles.low;
    case "credits":
      return styles.credits;
    case "out":
      return styles.out;
    default:
      return styles.unknown;
  }
}

/** The shared day axis above every lane: "Now", then each local midnight. */
export function DayAxis({ ticks }: { ticks: readonly DayTick[] }) {
  return (
    <View style={styles.axis} accessibilityElementsHidden importantForAccessibility="no">
      <Text style={[styles.axisText, styles.now]}>Now</Text>
      {ticks.map((tick) => (
        <View key={tick.at} style={[styles.tick, { left: pct(tick.at) }]} />
      ))}
      {ticks
        .filter((tick) => tick.center > LABEL_MARGIN && tick.center < 1 - LABEL_MARGIN)
        .map((tick) => (
          <Text
            key={tick.at}
            style={[styles.axisText, styles.dayLabel, { left: pct(tick.center) }]}
            numberOfLines={1}
          >
            {tick.label}
          </Text>
        ))}
    </View>
  );
}

/** A small sample of one lane style, for the key. */
export function LaneSwatch({ state }: { state: RunwayState | "reset" }) {
  if (state === "reset") {
    return (
      <View style={styles.swatch}>
        <View style={[styles.notch, styles.swatchNotch]} />
      </View>
    );
  }
  return (
    <View style={styles.swatch}>
      <View style={styles.track}>
        <View style={[styles.segment, segmentStyle(state), styles.swatchFill]} />
      </View>
    </View>
  );
}

const LANE_HEIGHT = 6;
const NOTCH_OVERHANG = 2;
const TICK_LABEL_WIDTH = 32;

const styles = StyleSheet.create((theme) => ({
  lane: { height: LANE_HEIGHT + NOTCH_OVERHANG * 2, justifyContent: "center" },
  track: {
    height: LANE_HEIGHT,
    borderRadius: LANE_HEIGHT / 2,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  segment: { position: "absolute", top: 0, bottom: 0, minWidth: 3 },
  capacity: { backgroundColor: theme.colors.foregroundMuted, opacity: 0.55 },
  low: { backgroundColor: theme.colors.statusWarning },
  // Credits keep work going, so they read as a fainter capacity rather than a new hue.
  credits: { backgroundColor: theme.colors.foregroundMuted, opacity: 0.28 },
  out: { backgroundColor: theme.colors.destructive },
  unknown: { backgroundColor: "transparent" },
  notch: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    marginLeft: -0.5,
    backgroundColor: theme.colors.foreground,
    opacity: 0.7,
  },
  axis: { height: 16, marginBottom: 2 },
  axisText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: 10,
    lineHeight: 12,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  now: { position: "absolute", left: 0, top: 0, textAlign: "left" },
  dayLabel: {
    position: "absolute",
    top: 0,
    width: TICK_LABEL_WIDTH,
    marginLeft: -TICK_LABEL_WIDTH / 2,
  },
  tick: {
    position: "absolute",
    bottom: 0,
    width: 1,
    height: 3,
    backgroundColor: theme.colors.divider,
  },
  swatch: { width: 20, height: LANE_HEIGHT + NOTCH_OVERHANG * 2, justifyContent: "center" },
  swatchFill: { left: 0, right: 0 },
  swatchNotch: { left: 10 },
}));
