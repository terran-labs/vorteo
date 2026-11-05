import { StyleSheet as RNStyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Hourglass } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

export const HOURGLASS_SIZE = 10;
/** One drain and flip. Slow enough to read as waiting rather than working. */
export const SAND_PERIOD_MS = 9000;
/**
 * Waiting is background state, so the hourglass takes the idle dots' colour at a little more
 * strength than their 0.3, which a 10px outline needs to stay legible.
 */
export const HOURGLASS_OPACITY = 0.55;

// Sand geometry on the outline's 24-unit grid, scaled to the icon. Each bulb's sand is the bulb's
// whole interior, tucked 0.3 units under the stroke so no gap shows against the glass. The bottom
// bulb is the top mirrored about the neck (y = 12), which is what makes the loop seamless: the
// bottom always holds exactly what the top has lost, so once the hourglass turns over, the full
// bottom bulb is the full top bulb the next drain starts from.
const UNIT = HOURGLASS_SIZE / 24;
const SAND_FULL = 2.6;
const SAND_NECK = 11.2;
const SAND_FLOOR = 24 - SAND_FULL;
const SAND_DEPTH = SAND_NECK - SAND_FULL;
const TOP_SAND = "M7.6 2.6H16.4V6.2Q16.4 6.9 15.9 7.4L12 11.2L8.1 7.4Q7.6 6.9 7.6 6.2Z";
const PILE_SAND = "M7.6 21.4H16.4V17.8Q16.4 17.1 15.9 16.6L12 12.8L8.1 16.6Q7.6 17.1 7.6 17.8Z";
const TOP = { y: SAND_FULL * UNIT, height: SAND_DEPTH * UNIT };
const PILE = { y: (24 - SAND_NECK) * UNIT, height: SAND_DEPTH * UNIT };
// The stream starts just inside the neck so it reads as leaving the top bulb.
const STREAM_TOP = SAND_NECK - 0.4;
const STREAM = { y: STREAM_TOP * UNIT, height: (SAND_FLOOR - STREAM_TOP) * UNIT };

export interface SandTrack {
  offsets: number[];
  values: number[];
}

const DRAIN_START = 0.04;
const DRAIN_END = 0.72;
/** How long the first grain takes to fall from the neck to the floor: about 315 ms. */
const STREAM_FALL = 0.035;

/*
 * Each sand layer is a clipped window that slides while its content counter-slides, so the sand
 * stays put and only the visible edge moves. Both platforms animate these transforms; nothing is
 * laid out again per frame. Drain and pile share one linear timing so they stay exact mirrors.
 */
/** The top window's edge descends as the bulb empties. */
export const DRAIN_TRACK: SandTrack = {
  offsets: [0, DRAIN_START, DRAIN_END, 1],
  values: [0, 0, TOP.height, TOP.height],
};
/** The pile window rises from below the floor as sand lands. */
export const PILE_TRACK: SandTrack = {
  offsets: [0, DRAIN_START, DRAIN_END, 1],
  values: [PILE.height, PILE.height, 0, 0],
};

/**
 * The stream's offset inside its clipping window at a phase of the loop: 0 shows the whole
 * stream, -STREAM.height hides it. The first grain falls under gravity (distance grows with time
 * squared), then the tip rests on the rising pile until the top bulb is empty.
 */
export function streamOffset(phase: number): number {
  "worklet";
  if (phase <= DRAIN_START || phase >= DRAIN_END) return -STREAM.height;
  const pile = SAND_FLOOR - (SAND_DEPTH * (phase - DRAIN_START)) / (DRAIN_END - DRAIN_START);
  const fall = Math.min(1, (phase - DRAIN_START) / STREAM_FALL);
  const head = Math.min(pile, SAND_NECK + (SAND_FLOOR - SAND_NECK) * fall * fall);
  return Math.max(0, head - STREAM_TOP) * UNIT - STREAM.height;
}

/**
 * The same stream as keyframes for the web: dense through the fall, where the curve bends, then
 * one linear segment while the tip rides the pile up, which is exact because the pile is linear.
 */
export const STREAM_TRACK: SandTrack = (() => {
  const offsets = [0, DRAIN_START];
  for (let step = 1; step <= 12; step += 1) offsets.push(DRAIN_START + (STREAM_FALL * step) / 12);
  offsets.push(DRAIN_END - 0.0001, DRAIN_END, 1);
  return { offsets, values: offsets.map(streamOffset) };
})();

/** Once the sand has landed, the whole hourglass turns over, slowly, in degrees. */
export const FLIP_TRACK: SandTrack = {
  offsets: [0, 0.79, 1],
  values: [0, 0, 180],
};
/** Where the flip begins, for easing only that segment. */
export const FLIP_START = FLIP_TRACK.offsets[1] ?? 0.79;

const neutral = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const managed = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
export const hourglassColor = (muted: boolean) => (muted ? managed : neutral);

function Sand({ d, color }: { d: string; color?: string }) {
  return (
    <Svg width={HOURGLASS_SIZE} height={HOURGLASS_SIZE} viewBox="0 0 24 24">
      <Path d={d} fill={color} opacity={0.5} />
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
  frame: { width: HOURGLASS_SIZE, height: HOURGLASS_SIZE, opacity: HOURGLASS_OPACITY },
  /** Turns the sand and outline together around the icon's centre. */
  flip: { width: HOURGLASS_SIZE, height: HOURGLASS_SIZE },
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
  streamWindow: {
    position: "absolute",
    left: HOURGLASS_SIZE / 2 - 0.5,
    top: STREAM.y,
    width: 1,
    height: STREAM.height,
    overflow: "hidden",
  },
  streamContent: { position: "absolute", left: 0, top: 0, width: 1, height: STREAM.height },
});

const themed = StyleSheet.create((theme) => ({
  stream: { flex: 1, backgroundColor: theme.colors.foregroundExtraMuted, opacity: 0.5 },
  streamManaged: { backgroundColor: theme.colors.foregroundExtraMuted },
}));
