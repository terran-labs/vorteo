import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import type { View as NativeView } from "react-native";
import {
  STATUS_RING_CALM_PERIOD_MS,
  STATUS_RING_PERIOD_MS,
} from "@/components/status-ring/geometry";

const STATUS_RING_KEYFRAMES: PropertyIndexedKeyframes = {
  transform: ["rotate(0deg)", "rotate(360deg)"],
};
function ringTiming(durationMs: number): KeyframeAnimationOptions {
  return { duration: durationMs, easing: "linear", iterations: Number.POSITIVE_INFINITY };
}
const STATUS_RING_TIMELINE_START_MS = 0;

export function useStatusRingAnimationRef(tempo?: "calm"): RefCallback<NativeView> {
  const periodMs = tempo === "calm" ? STATUS_RING_CALM_PERIOD_MS : STATUS_RING_PERIOD_MS;
  const arcElement = useRef<HTMLElement | null>(null);
  const setArcElement = useCallback((instance: NativeView | null) => {
    arcElement.current = instance instanceof HTMLElement ? instance : null;
  }, []);

  useLayoutEffect(() => {
    const element = arcElement.current;
    if (!element) {
      return;
    }

    const animation = element.animate(STATUS_RING_KEYFRAMES, ringTiming(periodMs));
    animation.startTime = STATUS_RING_TIMELINE_START_MS;
    return () => {
      animation.cancel();
    };
  }, [periodMs]);

  return setArcElement;
}
