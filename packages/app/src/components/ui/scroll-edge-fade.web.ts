import { useCallback, useRef } from "react";
import type { ScrollView } from "react-native";
import type { ScrollEdgeFadeAxis } from "./scroll-edge-fade";

/** The fade used by compact scrollers such as the sidebar. The conversation uses 64px. */
export const SCROLL_EDGE_FADE_SIZE = 24;

/**
 * Masks a scroller so its content dissolves at an edge only while more content lies past
 * that edge, growing to `size` as the user scrolls away from it. This is the boundary fade
 * the conversation scroller uses; it masks the content itself, so it needs no knowledge of
 * the surface behind it and leaves the scroller's own background and borders untouched.
 */
export function edgeFadeMask(
  axis: ScrollEdgeFadeAxis,
  offset: number,
  overflow: number,
  size: number,
): string {
  const start = Math.min(size, Math.max(0, offset));
  const end = Math.min(size, Math.max(0, overflow - offset));
  const direction = axis === "vertical" ? "to bottom" : "to right";
  return `linear-gradient(${direction}, transparent, black ${start}px, black calc(100% - ${end}px), transparent)`;
}

/** Returns a ref for a React Native ScrollView; pass it as the ScrollView's `ref`. */
export function useScrollEdgeFade({
  axis = "vertical",
  size = SCROLL_EDGE_FADE_SIZE,
}: { axis?: ScrollEdgeFadeAxis; size?: number } = {}): (instance: ScrollView | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback(
    (instance: ScrollView | null) => {
      cleanup.current?.();
      cleanup.current = null;
      if (!instance) return;
      const node = instance.getScrollableNode() as HTMLElement | null;
      if (!node) return;
      const update = () => {
        const vertical = axis === "vertical";
        const offset = vertical ? node.scrollTop : node.scrollLeft;
        const overflow = vertical
          ? node.scrollHeight - node.clientHeight
          : node.scrollWidth - node.clientWidth;
        const mask = edgeFadeMask(axis, offset, overflow, size);
        node.style.maskImage = mask;
        node.style.setProperty("-webkit-mask-image", mask);
      };
      const resize = new ResizeObserver(update);
      resize.observe(node);
      // Content growth changes the overflow without a scroll or a scroller resize.
      for (const child of Array.from(node.children)) resize.observe(child);
      node.addEventListener("scroll", update, { passive: true });
      update();
      cleanup.current = () => {
        resize.disconnect();
        node.removeEventListener("scroll", update);
        node.style.maskImage = "";
        node.style.removeProperty("-webkit-mask-image");
      };
    },
    [axis, size],
  );
}
