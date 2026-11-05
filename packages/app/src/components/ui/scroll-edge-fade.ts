import { useCallback } from "react";
import type { ScrollView } from "react-native";

export type ScrollEdgeFadeAxis = "vertical" | "horizontal";

/**
 * Fades scroll content at an edge it overflows. Native has no CSS mask, so this is a no-op
 * there; see scroll-edge-fade.web.ts for the shared pattern.
 */
export function useScrollEdgeFade(
  _options: { axis?: ScrollEdgeFadeAxis; size?: number } = {},
): (instance: ScrollView | null) => void {
  return useCallback(() => undefined, []);
}
