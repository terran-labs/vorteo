import { StyleSheet as RNStyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Hourglass } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

export const HOURGLASS_SIZE = 10;
/** One drain, settle and reset. Slow enough to read as waiting rather than working. */
export const SAND_PERIOD_MS = 8000;

// Sand geometry on the outline's 24-unit grid, scaled to the icon.
const UNIT = HOURGLASS_SIZE / 24;
const TOP_SAND = "M8.6 4.2 H15.4 V6 L12 10.6 L8.6 6 Z";
const PILE_SAND =
  "M8.4 20.6 H15.6 V18.6 C15.6 17.4 13.4 15.8 12 15.6 C10.6 15.8 8.4 17.4 8.4 18.6 Z";
const TOP = { y: 4.2 * UNIT, height: 6.4 * UNIT };
const PILE = { y: 15.6 * UNIT, height: 5 * UNIT };
const STREAM = { y: 11.4 * UNIT, height: 8.6 * UNIT };

export interface SandTrack {
  offsets: number[];
  values: number[];
}

/*
 * Each sand layer is a clipped window that slides while its content counter-slides, so the sand
 * stays put and only the visible edge moves. Both platforms animate these transform and opacity
 * tracks; nothing is laid out again per frame.
 */
/** The top window's edge descends as the bulb empties. */
export const DRAIN_TRACK: SandTrack = {
  offsets: [0, 0.06, 0.82, 1],
  values: [0, 0, TOP.height, TOP.height],
};
/** The pile window rises from below the floor as sand lands. */
export const PILE_TRACK: SandTrack = {
  offsets: [0, 0.08, 0.84, 1],
  values: [PILE.height, PILE.height, 0, 0],
};
/** The settled pile fades before the next drain begins. */
export const PILE_FADE_TRACK: SandTrack = {
  offsets: [0, 0.84, 0.9, 0.97, 1],
  values: [1, 1, 1, 0, 0],
};
/** The stream shows only while sand is falling. */
export const STREAM_TRACK: SandTrack = {
  offsets: [0, 0.08, 0.8, 0.86, 1],
  values: [0, 1, 1, 0, 0],
};

const neutral = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const managed = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
export const hourglassColor = (muted: boolean) => (muted ? managed : neutral);

function Sand({ d, color }: { d: string; color?: string }) {
  return (
    <Svg width={HOURGLASS_SIZE} height={HOURGLASS_SIZE} viewBox="0 0 24 24">
      <Path d={d} fill={color} opacity={0.9} />
    </Svg>
  );
}
const ThemedSand = withUnistyles(Sand);
const ThemedOutline = withUnistyles(Hourglass);

export function TopSand({ muted }: { muted: boolean }) {
  return <ThemedSand d={TOP_SAND} uniProps={hourglassColor(muted)} />;
}
export function PileSand({ muted }: { muted: boolean }) {
  return <ThemedSand d={PILE_SAND} uniProps={hourglassColor(muted)} />;
}
export function StreamGrain({ muted }: { muted: boolean }) {
  return <View style={[themed.stream, muted && themed.streamManaged]} />;
}
export function HourglassOutline({ muted }: { muted: boolean }) {
  return (
    <View style={layers.full} pointerEvents="none">
      <ThemedOutline size={HOURGLASS_SIZE} strokeWidth={1.8} uniProps={hourglassColor(muted)} />
    </View>
  );
}

// Plain React Native styles: on native these land on Reanimated views, and a theme-tracked style
// on one crashes when the theme changes (docs/unistyles.md). Colour lives one level in.
export const layers = RNStyleSheet.create({
  frame: { width: HOURGLASS_SIZE, height: HOURGLASS_SIZE },
  full: { position: "absolute", top: 0, left: 0, width: HOURGLASS_SIZE, height: HOURGLASS_SIZE },
  topWindow: {
    position: "absolute",
    left: 0,
    top: TOP.y,
    width: HOURGLASS_SIZE,
    height: TOP.height,
    overflow: "hidden",
  },
  topContent: { position: "absolute", left: 0, top: -TOP.y },
  pileWindow: {
    position: "absolute",
    left: 0,
    top: PILE.y,
    width: HOURGLASS_SIZE,
    height: PILE.height,
    overflow: "hidden",
  },
  pileContent: { position: "absolute", left: 0, top: -PILE.y },
  stream: {
    position: "absolute",
    left: HOURGLASS_SIZE / 2 - 0.5,
    top: STREAM.y,
    width: 1,
    height: STREAM.height,
  },
});

const themed = StyleSheet.create((theme) => ({
  stream: { flex: 1, backgroundColor: theme.colors.foregroundMuted, opacity: 0.8 },
  streamManaged: { backgroundColor: theme.colors.foregroundExtraMuted },
}));
