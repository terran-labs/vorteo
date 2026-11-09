import { useMemo, useRef, type ReactElement } from "react";
import { usePathname } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Dimensions, View } from "react-native";
import { isWeb } from "@/constants/platform";
import { useEdgePanReservation } from "@/mobile-panels/edge-pan-reservation";
import { hasActiveOverlay } from "@/keyboard";
import { resolveMobilePanelGestureIntent } from "@/mobile-panels/gesture-intent";

/** Settings owns its close gesture; browser history may point somewhere unrelated. */
export function SettingsCloseGesture({
  children,
  onClose,
}: {
  children: ReactElement;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const focused = useIsFocused();
  const current = useRef({ pathname, focused, onClose });
  current.current = { pathname, focused, onClose };
  const { ref: edgeRef, reset: resetEdge } = useEdgePanReservation(
    "left",
    () => current.current.focused && !hasActiveOverlay(),
    () => (current.current.focused && !hasActiveOverlay() ? current.current.pathname : null),
  );
  const start = useRef({ x: 0, y: 0, pathname: "", eligible: false });
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .manualActivation(true)
        .onTouchesDown((event, manager) => {
          const touch = event.changedTouches[0];
          const eligible = Boolean(
            touch && touch.absoluteX <= 32 && current.current.focused && !hasActiveOverlay(),
          );
          start.current = {
            x: touch?.absoluteX ?? 0,
            y: touch?.absoluteY ?? 0,
            pathname: current.current.pathname,
            eligible,
          };
          if (!eligible) manager.fail();
        })
        .onTouchesMove((event, manager) => {
          const touch = event.changedTouches[0];
          if (
            !touch ||
            event.numberOfTouches !== 1 ||
            !start.current.eligible ||
            !current.current.focused ||
            current.current.pathname !== start.current.pathname
          ) {
            manager.fail();
            return;
          }
          const intent = resolveMobilePanelGestureIntent({
            deltaX: touch.absoluteX - start.current.x,
            deltaY: touch.absoluteY - start.current.y,
            direction: 1,
            openGesturesBlocked: hasActiveOverlay(),
          });
          if (intent === "fail") manager.fail();
          else if (intent === "activate") manager.activate();
        })
        .onEnd((event, success) => {
          if (
            success &&
            start.current.eligible &&
            current.current.focused &&
            current.current.pathname === start.current.pathname &&
            !hasActiveOverlay() &&
            // Gesture coordinates and the edge/velocity thresholds use unscaled viewport units.
            (event.translationX > Dimensions.get("window").width / 3 || event.velocityX > 500)
          ) {
            current.current.onClose();
          }
          start.current.eligible = false;
        })
        .onFinalize(() => {
          start.current.eligible = false;
          resetEdge();
        }),
    [resetEdge],
  );
  return (
    <GestureDetector gesture={gesture} touchAction={isWeb ? "auto" : "pan-y"}>
      <View ref={edgeRef} style={fillStyle}>
        {children}
      </View>
    </GestureDetector>
  );
}
const fillStyle = { flex: 1 };
