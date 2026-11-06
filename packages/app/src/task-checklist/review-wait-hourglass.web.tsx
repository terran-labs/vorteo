import { memo, useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import { View, type View as NativeView } from "react-native";
import {
  DRAIN_TRACK,
  FLIP_START,
  FLIP_TRACK,
  HourglassOutline,
  layers,
  PILE_TRACK,
  PileSand,
  SAND_PERIOD_MS,
  STREAM_TRACK,
  StreamGrain,
  TopSand,
  type SandTrack,
  useHourglassFrameStyle,
} from "./review-wait-hourglass-frame";

// Linear between keyframes: drain and pile must move at one rate to stay mirrors of each other,
// and the stream's gravity curve is already sampled into its keyframes.
const translate = (track: SandTrack, sign = 1): Keyframe[] =>
  track.offsets.map((offset, index) => ({
    offset,
    transform: `translateY(${sign * track.values[index]}px)`,
  }));

const DRAIN = translate(DRAIN_TRACK);
const DRAIN_COUNTER = translate(DRAIN_TRACK, -1);
const PILE = translate(PILE_TRACK);
const PILE_COUNTER = translate(PILE_TRACK, -1);
const STREAM = translate(STREAM_TRACK);
// Ease only the turn itself, so it starts and settles gently.
const FLIP: Keyframe[] = FLIP_TRACK.offsets.map((offset, index) => ({
  offset,
  transform: `rotate(${FLIP_TRACK.values[index]}deg)`,
  easing: offset === FLIP_START ? "cubic-bezier(0.45, 0, 0.55, 1)" : "linear",
}));

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Every hourglass runs on the document timeline from one fixed epoch, like the busy ring, so
 * rows that mount at different times still drain together.
 */
function useSandLoop(keyframes: Keyframe[]): RefCallback<NativeView> {
  const element = useRef<HTMLElement | null>(null);
  const setElement = useCallback((instance: NativeView | null) => {
    element.current = instance instanceof HTMLElement ? instance : null;
  }, []);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const animation = target.animate(keyframes, {
      duration: SAND_PERIOD_MS,
      iterations: Number.POSITIVE_INFINITY,
    });
    if (prefersReducedMotion()) {
      // Hold the first frame, matching native: a full top bulb, no pile and no stream.
      animation.pause();
      animation.currentTime = 0;
    } else {
      animation.startTime = 0;
    }
    return () => animation.cancel();
  }, [keyframes]);
  return setElement;
}

/** Web hourglass. Reduced motion holds the sand at rest in the top bulb. */
export const ReviewWaitHourglass = memo(function ReviewWaitHourglass({
  muted = false,
}: {
  muted?: boolean;
}) {
  const frameStyle = useHourglassFrameStyle();
  const drain = useSandLoop(DRAIN);
  const drainCounter = useSandLoop(DRAIN_COUNTER);
  const pile = useSandLoop(PILE);
  const pileCounter = useSandLoop(PILE_COUNTER);
  const stream = useSandLoop(STREAM);
  const flip = useSandLoop(FLIP);
  return (
    <View style={frameStyle}>
      <View ref={flip} style={layers.flip}>
        <View ref={drain} style={layers.topWindow}>
          <View ref={drainCounter} style={layers.topContent}>
            <TopSand muted={muted} />
          </View>
        </View>
        <View ref={pile} style={layers.pileWindow}>
          <View ref={pileCounter} style={layers.pileContent}>
            <PileSand muted={muted} />
          </View>
        </View>
        <View style={layers.streamWindow}>
          <View ref={stream} style={layers.streamContent}>
            <StreamGrain muted={muted} />
          </View>
        </View>
        <HourglassOutline muted={muted} />
      </View>
    </View>
  );
});
