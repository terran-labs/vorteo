import { memo } from "react";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import {
  StatusRingFrame,
  type StatusRingProps,
  rotatorStyles,
  StatusRingArc,
} from "@/components/status-ring/frame";
import { useStatusRingRotation } from "@/components/status-ring/clock";
import {
  getStatusRingRotation,
  STATUS_RING_CALM_PERIOD_MS,
} from "@/components/status-ring/geometry";

/**
 * Native running indicator. The rotation is published by one shared UI-thread clock rather than
 * per-instance timing, so a ring that mounts mid-flight is already in phase — see `clock.ts`.
 *
 * The rotated view carries no theme-tracked style; the coloured arc is nested inside it. Putting
 * a Unistyles style on a Reanimated view crashes on theme change (docs/unistyles.md).
 */
export const StatusRing = memo(function StatusRing({
  backdrop,
  variant,
  tone,
  tempo,
}: StatusRingProps) {
  const rotation = useStatusRingRotation();
  const calmTempo = tempo === "calm";
  // The shared clock ticks every frame; a calm ring reads it only as a tick and takes its own
  // slower wall-clock phase, so calm rings stay in step with each other.
  const rotatorStyle = useAnimatedStyle(() => {
    const tick = rotation.value;
    const angle = calmTempo ? getStatusRingRotation(Date.now(), STATUS_RING_CALM_PERIOD_MS) : tick;
    return { transform: [{ rotate: `${angle}deg` }] };
  });

  return (
    <StatusRingFrame backdrop={backdrop} variant={variant}>
      <Animated.View style={[rotatorStyles.rotator, rotatorStyle]}>
        <StatusRingArc variant={variant} tone={tone} />
      </Animated.View>
    </StatusRingFrame>
  );
});
