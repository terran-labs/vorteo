import { memo, useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import { View, type View as NativeView } from "react-native";
import {
  DRAIN_TRACK,
  HourglassOutline,
  layers,
  PILE_FADE_TRACK,
  PILE_TRACK,
  PileSand,
  SAND_PERIOD_MS,
  STREAM_TRACK,
  StreamGrain,
  TopSand,
  type SandTrack,
} from "./review-wait-hourglass-frame";

const translate = (track: SandTrack, sign = 1): Keyframe[] =>
  track.offsets.map((offset, index) => ({
    offset,
    transform: `translateY(${sign * track.values[index]}px)`,
    easing: "ease-in-out",
  }));
const fade = (track: SandTrack): Keyframe[] =>
  track.offsets.map((offset, index) => ({ offset, opacity: track.values[index] }));

const DRAIN = translate(DRAIN_TRACK);
const DRAIN_COUNTER = translate(DRAIN_TRACK, -1);
const PILE = translate(PILE_TRACK);
const PILE_COUNTER = translate(PILE_TRACK, -1);
const PILE_FADE = fade(PILE_FADE_TRACK);
const STREAM = fade(STREAM_TRACK);

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
  const drain = useSandLoop(DRAIN);
  const drainCounter = useSandLoop(DRAIN_COUNTER);
  const pile = useSandLoop(PILE);
  const pileCounter = useSandLoop(PILE_COUNTER);
  const pileFade = useSandLoop(PILE_FADE);
  const stream = useSandLoop(STREAM);
  return (
    <View style={layers.frame}>
      <View ref={drain} style={layers.topWindow}>
        <View ref={drainCounter} style={layers.topContent}>
          <TopSand muted={muted} />
        </View>
      </View>
      <View ref={pileFade} style={layers.full}>
        <View ref={pile} style={layers.pileWindow}>
          <View ref={pileCounter} style={layers.pileContent}>
            <PileSand muted={muted} />
          </View>
        </View>
      </View>
      <View ref={stream} style={layers.stream}>
        <StreamGrain muted={muted} />
      </View>
      <HourglassOutline muted={muted} />
    </View>
  );
});
