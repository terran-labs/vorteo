import { useCallback } from "react";
import type { ScrollView } from "react-native";

export type ScrollEdgeFadeAxis = "vertical" | "horizontal";

export interface ScrollEdgeFadeOptions {
  axis?: ScrollEdgeFadeAxis;
  /** The fade's full depth in pixels. Defaults to 24, the compact scroller size. */
  size?: number;
}

export const SCROLL_EDGE_FADE_SIZE = 24;

/** Marks a sticky header inside a fading scroller so the fade starts below it (web only). */
export const SCROLL_EDGE_STICKY_DATASET = { scrollEdgeSticky: "" } as const;

/*
 * Fades scroll content at an edge it overflows. Native has no CSS mask, so these are no-ops
 * there; see scroll-edge-fade.web.ts for the shared pattern.
 */

export function attachScrollEdgeFade(
  _node: unknown,
  _options: ScrollEdgeFadeOptions = {},
): () => void {
  return () => undefined;
}

export function useElementEdgeFade(_options: ScrollEdgeFadeOptions = {}): (node: unknown) => void {
  return useCallback(() => undefined, []);
}

export function useScrollEdgeFade(
  _options: ScrollEdgeFadeOptions = {},
): (instance: ScrollView | null) => void {
  return useCallback(() => undefined, []);
}
