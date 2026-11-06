import { useCallback, useRef } from "react";
import type { ScrollView } from "react-native";
import type { ScrollEdgeFadeAxis, ScrollEdgeFadeOptions } from "./scroll-edge-fade";

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
  stickyInset = 0,
): string {
  const start = Math.min(size, Math.max(0, offset));
  const end = Math.min(size, Math.max(0, overflow - offset));
  const direction = axis === "vertical" ? "to bottom" : "to right";
  // A sticky header stays fully drawn; the content fades in just below it instead.
  const head =
    stickyInset > 0 && start > 0
      ? `black, black ${stickyInset}px, transparent ${stickyInset}px, black ${stickyInset + start}px`
      : `transparent, black ${start}px`;
  return `linear-gradient(${direction}, ${head}, black calc(100% - ${end}px), transparent)`;
}

/**
 * Marks a sticky header inside a fading scroller, so the fade starts below it:
 * `<View style={sticky} dataSet={SCROLL_EDGE_STICKY_DATASET}>`.
 */
export const SCROLL_EDGE_STICKY_DATASET = { scrollEdgeSticky: "" } as const;

/** How far the scroller's sticky headers reach below its top edge. */
function stickyInsetOf(node: HTMLElement): number {
  const stuck = node.querySelectorAll<HTMLElement>("[data-scroll-edge-sticky]");
  if (stuck.length === 0) return 0;
  const top = node.getBoundingClientRect().top;
  let inset = 0;
  for (const header of Array.from(stuck)) {
    inset = Math.max(inset, header.getBoundingClientRect().bottom - top);
  }
  return Math.max(0, inset);
}

/**
 * Applies the edge fade to a scrolling DOM node and keeps it current as the node scrolls,
 * resizes or grows. Returns the cleanup. Use it directly for a plain `overflow: auto`
 * element; React Native scrollers get it from the shared ScrollView and FlatList.
 */
export function attachScrollEdgeFade(
  node: HTMLElement,
  { axis = "vertical", size = SCROLL_EDGE_FADE_SIZE }: ScrollEdgeFadeOptions = {},
): () => void {
  const update = () => {
    const vertical = axis === "vertical";
    const offset = vertical ? node.scrollTop : node.scrollLeft;
    const overflow = vertical
      ? node.scrollHeight - node.clientHeight
      : node.scrollWidth - node.clientWidth;
    // An unclipped edge stays unmasked, so a scroller that fits paints no mask at all.
    if (overflow <= 0) {
      node.style.maskImage = "";
      node.style.removeProperty("-webkit-mask-image");
      return;
    }
    const stickyInset = vertical && offset > 0 ? stickyInsetOf(node) : 0;
    const mask = edgeFadeMask(axis, offset, overflow, size, stickyInset);
    node.style.maskImage = mask;
    node.style.setProperty("-webkit-mask-image", mask);
  };
  const resize = new ResizeObserver(update);
  resize.observe(node);
  // Content growth changes the overflow without a scroll or a scroller resize.
  const observeChildren = () => {
    for (const child of Array.from(node.children)) resize.observe(child);
  };
  observeChildren();
  // A list can replace its content container, so watch for new direct children too.
  const children = new MutationObserver(() => {
    observeChildren();
    update();
  });
  children.observe(node, { childList: true });
  node.addEventListener("scroll", update, { passive: true });
  update();
  return () => {
    resize.disconnect();
    children.disconnect();
    node.removeEventListener("scroll", update);
    node.style.maskImage = "";
    node.style.removeProperty("-webkit-mask-image");
  };
}

/** Returns a ref callback that fades a DOM node at the edges it overflows. */
export function useElementEdgeFade(
  options: ScrollEdgeFadeOptions = {},
): (node: HTMLElement | null) => void {
  const { axis = "vertical", size = SCROLL_EDGE_FADE_SIZE } = options;
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback(
    (node: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = node ? attachScrollEdgeFade(node, { axis, size }) : null;
    },
    [axis, size],
  );
}

/**
 * Returns a ref for a React Native ScrollView; pass it as the ScrollView's `ref`. Prefer the
 * shared ScrollView in `@/components/ui/scroll-view`, which applies this by default.
 */
export function useScrollEdgeFade(
  options: ScrollEdgeFadeOptions = {},
): (instance: ScrollView | null) => void {
  const fadeElement = useElementEdgeFade(options);
  return useCallback(
    (instance: ScrollView | null) => {
      fadeElement((instance?.getScrollableNode() as HTMLElement | null) ?? null);
    },
    [fadeElement],
  );
}
