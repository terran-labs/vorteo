import { useCallback, useEffect, useRef } from "react";
import type { LayoutChangeEvent } from "react-native";
import { create } from "zustand";

/**
 * Whether the sidebar's scrolling list fills its space down to the footer block. The footer's
 * top rule separates the two only when they meet; a short list leaves open space instead.
 */
export const useSidebarListReach = create<{
  reaches: boolean;
  setReaches: (reaches: boolean) => void;
}>((set) => ({
  reaches: true,
  setReaches: (reaches) => set((state) => (state.reaches === reaches ? state : { reaches })),
}));

/** Layout and content-size handlers for the sidebar list's scroll view. */
export function useSidebarListReachReporter(forward?: (width: number, height: number) => void): {
  onLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number, height: number) => void;
} {
  const setReaches = useSidebarListReach((state) => state.setReaches);
  const sizes = useRef({ viewport: 0, content: 0 });
  const update = useCallback(() => {
    const { viewport, content } = sizes.current;
    // Until both are measured, keep the rule: hiding it first would flash on load.
    setReaches(viewport === 0 || content === 0 || content >= viewport - 1);
  }, [setReaches]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      sizes.current.viewport = event.nativeEvent.layout.height;
      update();
    },
    [update],
  );
  const onContentSizeChange = useCallback(
    (width: number, height: number) => {
      sizes.current.content = height;
      update();
      forward?.(width, height);
    },
    [forward, update],
  );
  // Another list, or none, may take its place; the rule's default is to show.
  useEffect(() => () => setReaches(true), [setReaches]);
  return { onLayout, onContentSizeChange };
}
