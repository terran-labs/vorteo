import { memo } from "react";
import { View } from "react-native";
import {
  StatusRingFrame,
  type StatusRingProps,
  rotatorStyles,
  StatusRingArc,
} from "@/components/status-ring/frame";
import { useStatusRingAnimationRef } from "@/components/status-ring/clock.web";

/**
 * Web running indicator. A sidebar full of agents can hold dozens of these at once, so the browser
 * drives the rotation from one absolute document-timeline epoch rather than from mount time — see
 * `clock.web.ts`.
 */
export const StatusRing = memo(function StatusRing({
  backdrop,
  variant,
  tone,
  tempo,
}: StatusRingProps) {
  const rotatorRef = useStatusRingAnimationRef(tempo);

  return (
    <StatusRingFrame backdrop={backdrop} variant={variant}>
      <View ref={rotatorRef} style={rotatorStyles.rotator}>
        <StatusRingArc variant={variant} tone={tone} />
      </View>
    </StatusRingFrame>
  );
});
