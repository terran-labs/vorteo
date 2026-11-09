import { View, Text } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const SIZE = 40;
const RADIUS = 17;
const SEGMENTS = 32;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const STEP = CIRCUMFERENCE / SEGMENTS;
const DASH = `${STEP * 0.65} ${STEP * 0.35}`;

/** Equal arc lengths and equal gaps keep context capacity distinct from a loading spinner. */
export function ContextUsageRing({ percentage }: { percentage: number }) {
  const filled = Math.round((Math.max(0, Math.min(100, percentage)) / 100) * SEGMENTS);
  return (
    <View style={styles.container} pointerEvents="none">
      <ThemedRingGraphic filled={filled} />
      <View style={styles.label}>
        <Text style={styles.text}>{percentage}%</Text>
      </View>
    </View>
  );
}
// Theme the whole graphic: wrapping individual SVG primitives inserts HTML on web.
function RingGraphic({ filled, track, ink }: { filled: number; track: string; ink: string }) {
  return (
    <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <Circle
        stroke={track}
        cx={20}
        cy={20}
        r={RADIUS}
        fill="none"
        strokeWidth={3}
        strokeDasharray={DASH}
        transform="rotate(-90 20 20)"
      />
      {Array.from({ length: filled }, (_, index) => (
        <Circle
          stroke={ink}
          key={index}
          cx={20}
          cy={20}
          r={RADIUS}
          fill="none"
          strokeWidth={3}
          strokeDasharray={`${STEP * 0.65} ${CIRCUMFERENCE - STEP * 0.65}`}
          transform={`rotate(${-90 + (index * 360) / SEGMENTS} 20 20)`}
        />
      ))}
    </Svg>
  );
}
const ThemedRingGraphic = withUnistyles(RingGraphic, (theme) => ({
  track: theme.colors.border,
  ink: theme.colors.foregroundMuted,
}));

const styles = StyleSheet.create((theme) => ({
  container: { width: SIZE, height: SIZE },
  label: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
}));
