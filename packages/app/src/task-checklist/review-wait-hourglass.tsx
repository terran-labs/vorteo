import { memo, useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  DRAIN_TRACK,
  FLIP_START,
  HourglassOutline,
  layers,
  PILE_FADE_TRACK,
  PILE_TRACK,
  PileSand,
  SAND_PERIOD_MS,
  STREAM_TRACK,
  StreamGrain,
  TopSand,
} from "./review-wait-hourglass-frame";

const FLIP_EASING = Easing.inOut(Easing.cubic);

/**
 * Native hourglass. One phase value per icon drives every layer on the UI thread. Rows are not
 * phase-locked as the busy ring is; a slow, quiet drain reads the same out of step. Reduced
 * motion holds the sand at rest in the top bulb.
 */
export const ReviewWaitHourglass = memo(function ReviewWaitHourglass({
  muted = false,
}: {
  muted?: boolean;
}) {
  const reduced = useReducedMotion();
  const phase = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    phase.value = withRepeat(
      withTiming(1, { duration: SAND_PERIOD_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(phase);
  }, [phase, reduced]);

  const drain = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          phase.value,
          DRAIN_TRACK.offsets,
          DRAIN_TRACK.values,
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
  const drainCounter = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: -interpolate(
          phase.value,
          DRAIN_TRACK.offsets,
          DRAIN_TRACK.values,
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
  const pile = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          phase.value,
          PILE_TRACK.offsets,
          PILE_TRACK.values,
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
  const pileCounter = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: -interpolate(
          phase.value,
          PILE_TRACK.offsets,
          PILE_TRACK.values,
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
  const pileFade = useAnimatedStyle(() => ({
    opacity: interpolate(
      phase.value,
      PILE_FADE_TRACK.offsets,
      PILE_FADE_TRACK.values,
      Extrapolation.CLAMP,
    ),
  }));
  const stream = useAnimatedStyle(() => ({
    opacity: interpolate(
      phase.value,
      STREAM_TRACK.offsets,
      STREAM_TRACK.values,
      Extrapolation.CLAMP,
    ),
  }));

  // The turn is eased on its own segment, so it starts and settles gently.
  const flip = useAnimatedStyle(() => {
    const t = Math.min(1, Math.max(0, (phase.value - FLIP_START) / (1 - FLIP_START)));
    return { transform: [{ rotate: `${FLIP_EASING(t) * 180}deg` }] };
  });

  return (
    <View style={layers.frame}>
      <Animated.View style={[layers.flip, flip]}>
        <Animated.View style={[layers.topWindow, drain]}>
          <Animated.View style={[layers.topContent, drainCounter]}>
            <TopSand muted={muted} />
          </Animated.View>
        </Animated.View>
        <Animated.View style={[layers.full, pileFade]}>
          <Animated.View style={[layers.pileWindow, pile]}>
            <Animated.View style={[layers.pileContent, pileCounter]}>
              <PileSand muted={muted} />
            </Animated.View>
          </Animated.View>
        </Animated.View>
        <Animated.View style={[layers.stream, stream]}>
          <StreamGrain muted={muted} />
        </Animated.View>
        <HourglassOutline muted={muted} />
      </Animated.View>
    </View>
  );
});
