import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { groupHoverStyle, hoverGroup } from "@/styles/hover";
import { usePointerResize } from "@/components/use-pointer-resize";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { isWeb } from "@/constants/platform";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";
import { usePanelStore } from "@/stores/panel-store";

/** Shortest card a drag can leave: the header plus a row of content. */
export const CARD_MIN_RESIZE_HEIGHT = 72;
const DOUBLE_PRESS_MS = 350;

/**
 * A strip along a card's bottom edge that drags the card taller or shorter. The owner keeps the
 * height; this reports a preview while dragging and the final height on release. A double press
 * returns the card to automatic sizing.
 *
 * The `divider` placement covers a rule above a section instead, so dragging up grows the section
 * below it. Touch layouts show a small grip there because they have no hover highlight.
 */
export function CardHeightHandle({
  height,
  maxHeight,
  onPreview,
  onCommit,
  onReset,
  testID,
  placement = "bottom",
}: {
  placement?: "bottom" | "divider";
  /** The card's current rendered height, where a drag starts. */
  height: number;
  maxHeight: number;
  onPreview: (height: number) => void;
  onCommit: (height: number) => void;
  onReset: () => void;
  testID: string;
}) {
  const finePointer = useHasFinePointer();
  const [pressed, setPressed] = useState(false);
  const lastPress = useRef(0);
  const start = useRef(height);
  const sign = placement === "divider" ? -1 : 1;
  const clamp = useCallback(
    (delta: number) =>
      Math.round(
        Math.min(
          Math.max(CARD_MIN_RESIZE_HEIGHT, maxHeight),
          Math.max(CARD_MIN_RESIZE_HEIGHT, start.current + sign * delta),
        ),
      ),
    [maxHeight, sign],
  );
  const begin = useCallback(() => {
    const now = Date.now();
    if (now - lastPress.current < DOUBLE_PRESS_MS) {
      lastPress.current = 0;
      onReset();
      return null;
    }
    lastPress.current = now;
    start.current = height;
    let next = height;
    return {
      move: (delta: number) => {
        next = clamp(delta);
        onPreview(next);
      },
      finish: () => {
        // A press without movement is the first half of a possible double press.
        if (next !== height) onCommit(next);
      },
    };
  }, [clamp, height, onCommit, onPreview, onReset]);
  const onPointerDown = usePointerResize({
    direction: "vertical",
    begin,
    onDraggingChange: setPressed,
  });
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetY([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
      .failOffsetX([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
      .onBegin(() => {
        start.current = height;
        setPressed(true);
      })
      .onUpdate((event) => onPreview(clamp(event.translationY)))
      .onEnd((event) => onCommit(clamp(event.translationY)))
      .onFinalize(() => setPressed(false));
    const reset = Gesture.Tap().runOnJS(true).numberOfTaps(2).onEnd(onReset);
    return Gesture.Race(pan, reset);
  }, [clamp, height, onCommit, onPreview, onReset]);
  const divider = placement === "divider";
  // Hover is a separate CSS layer so the browser clears it when a reset moves the handle away.
  const opacity = pressed ? 0.34 : 0;
  const highlightStyle = useAnimatedStyle(
    () => ({ opacity: withTiming(opacity, { duration: 180, reduceMotion: ReduceMotion.System }) }),
    [opacity],
  );
  const target = (
    <View
      testID={testID}
      role="separator"
      aria-orientation="horizontal"
      accessibilityLabel="Resize card height"
      accessibilityHint="Drag to resize. Double press to size automatically."
      collapsable={false}
      style={[
        divider ? styles.dividerTarget : styles.target,
        finePointer ? styles.pointerTarget : styles.touchTarget,
        divider && !finePointer && styles.touchDividerTarget,
        styles.hoverGroup,
        webCursor,
      ]}
      onPointerDown={isWeb ? onPointerDown : undefined}
    >
      {finePointer ? (
        <View
          pointerEvents="none"
          style={[
            styles.hoverHighlight,
            divider ? styles.dividerHoverHighlight : styles.bottomHoverHighlight,
            !pressed && styles.hoverHighlightVisible,
          ]}
        />
      ) : null}
      <Animated.View
        pointerEvents="none"
        style={[styles.highlight, divider && styles.dividerHighlight, highlightStyle]}
      />
      {divider && !finePointer ? <View pointerEvents="none" style={styles.touchGrip} /> : null}
    </View>
  );
  return isWeb ? target : <GestureDetector gesture={gesture}>{target}</GestureDetector>;
}

const webCursor = isWeb ? ({ cursor: "row-resize", touchAction: "none" } as object) : null;

const styles = StyleSheet.create((theme) => ({
  target: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  // Centered on a rule drawn along its row's top edge, extending above and below the line.
  dividerTarget: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -4,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  pointerTarget: { height: 8 },
  touchTarget: { height: 20 },
  touchDividerTarget: { top: -10 },
  dividerHighlight: { marginBottom: 0 },
  touchGrip: {
    position: "absolute",
    width: 28,
    height: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  highlight: {
    width: "100%",
    height: 2,
    marginBottom: 1,
    borderRadius: 999,
    backgroundColor: theme.colors.foreground,
  },
  hoverGroup: hoverGroup("card-height-handle"),
  // Same line as `highlight`, absolutely placed inside the 8px pointer target.
  hoverHighlight: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    borderRadius: 999,
    backgroundColor: theme.colors.foreground,
    opacity: 0,
    _web: { transition: "opacity 180ms" },
  },
  bottomHoverHighlight: { bottom: 1 },
  dividerHoverHighlight: { top: 3 },
  hoverHighlightVisible: groupHoverStyle(
    "card-height-handle",
    { opacity: 0.18 },
    { transition: "opacity 180ms" },
  ),
}));

/**
 * The device's dragged height for one card plus the live drag preview. `key` names the card; an
 * undefined key, or a disabled card, sizes automatically.
 */
export function useDraggedCardHeight(key: string | undefined, enabled = true) {
  const active = enabled && key !== undefined;
  const stored = usePanelStore((state) => (active ? state.cardHeights[key] : undefined));
  const setCardHeight = usePanelStore((state) => state.setCardHeight);
  const [preview, setPreview] = useState<number | null>(null);
  const commit = useCallback(
    (height: number) => {
      if (key !== undefined) setCardHeight(key, height);
      setPreview(null);
    },
    [key, setCardHeight],
  );
  const reset = useCallback(() => {
    if (key !== undefined) setCardHeight(key, null);
    setPreview(null);
  }, [key, setCardHeight]);
  return {
    active,
    height: active ? (preview ?? stored) : undefined,
    dragging: preview !== null,
    preview: setPreview,
    commit,
    reset,
  };
}

/** The handle for a card using {@link useDraggedCardHeight}; nothing while the card is fixed-size. */
export function DraggedCardHeightHandle({
  card,
  cardKey,
  height,
  maxHeight,
  placement,
}: {
  card: ReturnType<typeof useDraggedCardHeight>;
  cardKey: string | undefined;
  height: number;
  maxHeight: number;
  placement?: "bottom" | "divider";
}) {
  if (!card.active || cardKey === undefined) return null;
  return (
    <CardHeightHandle
      height={height}
      maxHeight={maxHeight}
      onPreview={card.preview}
      onCommit={card.commit}
      onReset={card.reset}
      placement={placement}
      testID={`${cardKey}-height-handle`}
    />
  );
}
