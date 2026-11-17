import { createContext, useContext, useRef, type RefObject, useCallback, useMemo } from "react";
import { Gesture, type GestureType } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { isWeb } from "@/constants/platform";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { usePanelStore } from "@/stores/panel-store";
import { canBeginMobilePanelGesture, isMobilePanelGestureCurrent } from "./model";
import { useMobilePanelsRuntime } from "./provider";
import { resolveMobilePanelGestureIntent } from "./gesture-intent";
import { usePathname } from "expo-router";
import { Dimensions } from "react-native";
import { hasActiveOverlay } from "@/keyboard";
import { useEdgePanReservation } from "./edge-pan-reservation";

const MOBILE_WEB_EDGE_SWIPE_WIDTH = 32;

/** Phone Settings navigation must not preview or settle the retired Explorer drawer. */
export function useOpenSettingsGesture({
  enabled,
  routeKey,
  onOpen,
}: {
  enabled: boolean;
  routeKey: string;
  onOpen: () => void;
}) {
  const { motionState, position, openGesturesBlocked } = useMobilePanelsRuntime();
  const current = useRef({ enabled, routeKey, onOpen });
  current.current = { enabled, routeKey, onOpen };
  const start = useRef({ x: 0, y: 0, revision: -1, routeKey: "", eligible: false });
  const { ref: edgeRef, reset: resetEdge } = useEdgePanReservation(
    "right",
    () =>
      current.current.enabled &&
      !openGesturesBlocked.value &&
      !hasActiveOverlay() &&
      canBeginMobilePanelGesture(motionState.value, "agent", position.value),
    () =>
      current.current.enabled && !openGesturesBlocked.value && !hasActiveOverlay()
        ? `${current.current.routeKey}:${usePanelStore.getState().mobilePanel.revision}`
        : null,
  );
  const gesture = useMemo(() => {
    const available = () =>
      current.current.enabled &&
      !openGesturesBlocked.value &&
      !hasActiveOverlay() &&
      canBeginMobilePanelGesture(motionState.value, "agent", position.value);
    const stillCurrent = () =>
      start.current.eligible &&
      current.current.routeKey === start.current.routeKey &&
      usePanelStore.getState().mobilePanel.revision === start.current.revision &&
      available();
    return Gesture.Pan()
      .runOnJS(true)
      .maxPointers(1)
      .manualActivation(true)
      .onTouchesDown((event, manager) => {
        const touch = event.changedTouches[0];
        const eligible = Boolean(
          touch &&
          touch.absoluteX >= Dimensions.get("window").width - MOBILE_WEB_EDGE_SWIPE_WIDTH &&
          available(),
        );
        start.current = {
          x: touch?.absoluteX ?? 0,
          y: touch?.absoluteY ?? 0,
          revision: usePanelStore.getState().mobilePanel.revision,
          routeKey: current.current.routeKey,
          eligible,
        };
        if (!eligible) manager.fail();
      })
      .onTouchesMove((event, manager) => {
        const touch = event.changedTouches[0];
        if (!touch || event.numberOfTouches !== 1 || !stillCurrent()) {
          manager.fail();
          return;
        }
        const intent = resolveMobilePanelGestureIntent({
          deltaX: touch.absoluteX - start.current.x,
          deltaY: touch.absoluteY - start.current.y,
          direction: -1,
          openGesturesBlocked: false,
        });
        if (intent === "fail") manager.fail();
        else if (intent === "activate") manager.activate();
      })
      .onEnd((event, success) => {
        if (
          success &&
          stillCurrent() &&
          (event.translationX < -Dimensions.get("window").width / 3 || event.velocityX < -500)
        ) {
          start.current.eligible = false;
          current.current.onOpen();
        }
      })
      .onFinalize(() => {
        start.current.eligible = false;
        resetEdge();
      });
  }, [motionState, openGesturesBlocked, position, resetEdge]);
  return { gesture, edgeRef };
}

function isCurrentSelection(startedRevision: number): boolean {
  return usePanelStore.getState().mobilePanel.revision === startedRevision;
}

function useGestureState() {
  return {
    startedRevision: useSharedValue(-1),
    touchStartX: useSharedValue(0),
    touchStartY: useSharedValue(0),
  };
}

function useRevisionCommit(action: () => void) {
  return useCallback(
    (revision: number) => {
      if (isCurrentSelection(revision)) {
        action();
      }
    },
    [action],
  );
}

export function useOpenAgentListGesture(enabled: boolean) {
  const {
    beginGesture,
    finishGesture,
    leftOpenGestureRef,
    motionState,
    openGesturesBlocked,
    position,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const horizontalScroll = useHorizontalScrollOptional();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const showMobileAgentList = usePanelStore((state) => state.showMobileAgentList);
  const commit = useRevisionCommit(showMobileAgentList);

  return useMemo(
    () =>
      Gesture.Pan()
        .withRef(leftOpenGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: 1,
            openGesturesBlocked: openGesturesBlocked.value,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent", position.value) ||
            horizontalScroll?.isAnyScrolledRight.value ||
            (isWeb && touchStartX.value > MOBILE_WEB_EDGE_SWIPE_WIDTH) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({ origin: "agent" });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldOpen = event.translationX > windowWidth / 3 || event.velocityX > 500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldOpen ? "agent-list" : "agent",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      commit,
      enabled,
      beginGesture,
      finishGesture,
      horizontalScroll?.isAnyScrolledRight,
      leftOpenGestureRef,
      motionState,
      openGesturesBlocked,
      position,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );
}

export function useCloseAgentListGesture() {
  const {
    beginGesture,
    finishGesture,
    leftCloseGestureRef,
    motionState,
    position,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const commit = useRevisionCommit(showMobileAgent);
  const pathname = usePathname();
  const { ref: edgeRef, reset: resetEdge } = useEdgePanReservation(
    "right",
    () =>
      !hasActiveOverlay() &&
      canBeginMobilePanelGesture(motionState.value, "agent-list", position.value),
    () =>
      !hasActiveOverlay() ? `${pathname}:${usePanelStore.getState().mobilePanel.revision}` : null,
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(leftCloseGestureRef)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: -1,
            openGesturesBlocked: false,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent-list", position.value) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "agent-list",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -1 - event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldClose = event.translationX < -windowWidth / 3 || event.velocityX < -500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldClose ? "agent" : "agent-list",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        })
        .onFinalize(() => {
          scheduleOnRN(resetEdge);
        }),
    [
      resetEdge,
      beginGesture,
      commit,
      finishGesture,
      leftCloseGestureRef,
      motionState,
      position,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );

  return { gesture, gestureRef: leftCloseGestureRef, edgeRef };
}

interface OpenFileExplorerGestureOptions {
  enabled: boolean;
  onOpen: () => void;
}

export function useOpenFileExplorerGesture({ enabled, onOpen }: OpenFileExplorerGestureOptions) {
  const {
    beginGesture,
    finishGesture,
    leftOpenGestureRef,
    motionState,
    openGesturesBlocked,
    position,
    rightOpenGestureRef,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const commit = useRevisionCommit(onOpen);

  return useMemo(
    () =>
      Gesture.Pan()
        .withRef(rightOpenGestureRef)
        .simultaneousWithExternalGesture(leftOpenGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: -1,
            openGesturesBlocked: openGesturesBlocked.value,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent", position.value) ||
            (isWeb && touchStartX.value < windowWidth - MOBILE_WEB_EDGE_SWIPE_WIDTH) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "agent",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldOpen = event.translationX < -windowWidth / 3 || event.velocityX < -500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldOpen ? "file-explorer" : "agent",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      beginGesture,
      commit,
      enabled,
      finishGesture,
      leftOpenGestureRef,
      motionState,
      openGesturesBlocked,
      position,
      rightOpenGestureRef,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );
}

export const FileExplorerCloseGestureContext = createContext<RefObject<
  GestureType | undefined
> | null>(null);

export function useCloseFileExplorerGesture(enabled = true) {
  const rightCloseGestureRef = useRef<GestureType | undefined>(undefined);
  const { beginGesture, finishGesture, motionState, position, updateGesture, windowWidth } =
    useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const horizontalScroll = useHorizontalScrollOptional();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const commit = useRevisionCommit(showMobileAgent);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(rightCloseGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: 1,
            openGesturesBlocked: false,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "file-explorer", position.value) ||
            horizontalScroll?.activeGestureStartedScrolled.value ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "file-explorer",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, 1 - event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldClose = event.translationX > windowWidth / 3 || event.velocityX > 500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldClose ? "agent" : "file-explorer",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      enabled,
      beginGesture,
      commit,
      finishGesture,
      horizontalScroll?.activeGestureStartedScrolled,
      motionState,
      position,
      rightCloseGestureRef,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );

  return { gesture, gestureRef: rightCloseGestureRef };
}

export function useFileExplorerCloseGestureRef() {
  return useContext(FileExplorerCloseGestureContext);
}
