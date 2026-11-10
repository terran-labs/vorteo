import { useCallback, useEffect, useRef } from "react";
import type { View } from "react-native";
import { resolveMobilePanelGestureIntent } from "./gesture-intent";

/** Reserve only an intentional edge pan before a nested browser scroller cancels its pointer. */
export function useEdgePanReservation(
  side: "left" | "right",
  canStart: () => boolean,
  identity: () => string | null,
) {
  const ref = useRef<View | null>(null);
  const current = useRef({ side, canStart, identity });
  current.current = { side, canStart, identity };
  const session = useRef<{ x: number; y: number; claimed: boolean; identity: string } | null>(null);
  const reset = useCallback(() => {
    session.current = null;
  }, []);
  useEffect(() => {
    const node = ref.current as unknown;
    if (!(node instanceof HTMLElement)) return;
    const down = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1 || !current.current.canStart()) return;
      const touch = event.touches[0];
      const atEdge =
        current.current.side === "left"
          ? touch.clientX <= 32
          : touch.clientX >= document.documentElement.clientWidth - 32;
      const token = current.current.identity();
      if (atEdge && token !== null)
        session.current = { x: touch.clientX, y: touch.clientY, claimed: false, identity: token };
    };
    const move = (event: TouchEvent) => {
      const start = session.current;
      if (!start) return;
      if (event.touches.length !== 1 || current.current.identity() !== start.identity) {
        reset();
        return;
      }
      const touch = event.touches[0];
      const intent = resolveMobilePanelGestureIntent({
        deltaX: touch.clientX - start.x,
        deltaY: touch.clientY - start.y,
        direction: current.current.side === "left" ? 1 : -1,
        openGesturesBlocked: false,
      });
      if (intent === "fail") {
        reset();
        return;
      }
      if (intent === "activate") start.claimed = true;
      if (start.claimed && event.cancelable) event.preventDefault();
    };
    node.addEventListener("touchstart", down, { capture: true, passive: true });
    node.addEventListener("touchmove", move, { capture: true, passive: false });
    node.addEventListener("touchend", reset, { capture: true, passive: true });
    node.addEventListener("touchcancel", reset, { capture: true, passive: true });
    node.addEventListener("pointercancel", reset, true);
    return () => {
      node.removeEventListener("touchstart", down, true);
      node.removeEventListener("touchmove", move, true);
      node.removeEventListener("touchend", reset, true);
      node.removeEventListener("touchcancel", reset, true);
      node.removeEventListener("pointercancel", reset, true);
      reset();
    };
  }, [reset]);
  return { ref, reset };
}
