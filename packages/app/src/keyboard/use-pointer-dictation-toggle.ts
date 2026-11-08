import { useEffect } from "react";

import { isWeb } from "@/constants/platform";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";

const MIDDLE_BUTTON = 1;
const TAP_FINGERS = 3;
/** A three-finger tap is quick; holding or resting fingers longer is not one. */
const TAP_MAX_DURATION_MS = 400;
/** Fingers that travel farther than this are swiping or pinching, not tapping. */
const TAP_MAX_TRAVEL_PX = 24;

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

/** Links keep middle click, which opens them in a new tab. */
export function shouldMiddleClickToggleDictation(target: EventTarget | null): boolean {
  return !isElement(target) || target.closest("a[href]") === null;
}

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

/**
 * Follows one touch sequence, from the first finger down to the last finger up, and reports
 * whether it was a three-finger tap: exactly three fingers at once, released quickly, without
 * moving. Pure so it can be tested without a touchscreen.
 */
export function createThreeFingerTapTracker(): {
  start: (touches: readonly TouchPoint[], allTouches: number, now: number) => void;
  move: (touches: readonly TouchPoint[]) => void;
  cancel: () => void;
  /** Returns true when the sequence that just ended is a three-finger tap. */
  end: (remainingTouches: number, now: number) => boolean;
} {
  let startedAt = 0;
  let maxFingers = 0;
  let disqualified = false;
  const origins = new Map<number, { x: number; y: number }>();

  const reset = () => {
    startedAt = 0;
    maxFingers = 0;
    disqualified = false;
    origins.clear();
  };

  return {
    start(touches, allTouches, now) {
      if (maxFingers === 0) startedAt = now;
      for (const touch of touches) {
        origins.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }
      maxFingers = Math.max(maxFingers, allTouches);
    },
    move(touches) {
      for (const touch of touches) {
        const origin = origins.get(touch.identifier);
        if (!origin) continue;
        if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > TAP_MAX_TRAVEL_PX) {
          disqualified = true;
        }
      }
    },
    cancel() {
      disqualified = true;
    },
    end(remainingTouches, now) {
      if (remainingTouches > 0) return false;
      const tapped =
        !disqualified && maxFingers === TAP_FINGERS && now - startedAt <= TAP_MAX_DURATION_MS;
      reset();
      return tapped;
    },
  };
}

/**
 * Toggles dictation into the active message field: the first gesture starts it, and the next
 * stops it and inserts the transcript for editing without sending.
 *
 * - Touchscreens: a three-finger tap anywhere in the window.
 * - Mouse and trackpad: a single middle click outside links. Browsers never report how many
 *   fingers touch a trackpad, so a trackpad three-finger tap only reaches the page when the
 *   operating system turns it into a middle click: on a Mac through a helper such as
 *   MiddleClick, and on Android tablets through the touchpad's three-finger tap setting.
 *
 * Triple click is left to the browser, which selects a line or paragraph.
 */
export function usePointerDictationToggle(enabled: boolean): void {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();

  useEffect(() => {
    if (!isWeb || !enabled || typeof window === "undefined") return;
    let lastPointerType = "mouse";
    const tap = createThreeFingerTapTracker();

    const handlePointerDown = (event: PointerEvent) => {
      lastPointerType = event.pointerType;
    };
    const isToggleMiddleClick = (event: MouseEvent) =>
      event.button === MIDDLE_BUTTON &&
      lastPointerType !== "touch" &&
      shouldMiddleClickToggleDictation(event.target);
    const toggleDictation = () =>
      keyboardActionDispatcher.dispatch({
        id: "message-input.dictation-insert-toggle",
        scope: "message-input",
      });

    // Stop a middle press from starting autoscroll.
    const handleMouseDown = (event: MouseEvent) => {
      if (isToggleMiddleClick(event)) event.preventDefault();
    };
    // Safari has no auxclick, so the middle button toggles on release.
    const handleMouseUp = (event: MouseEvent) => {
      if (isToggleMiddleClick(event) && toggleDictation()) event.preventDefault();
    };
    const handleAuxClick = (event: MouseEvent) => {
      if (isToggleMiddleClick(event)) event.preventDefault();
    };

    const handleTouchStart = (event: TouchEvent) => {
      tap.start(Array.from(event.changedTouches), event.touches.length, event.timeStamp);
    };
    const handleTouchMove = (event: TouchEvent) => {
      tap.move(Array.from(event.changedTouches));
    };
    const handleTouchCancel = (event: TouchEvent) => {
      tap.cancel();
      tap.end(event.touches.length, event.timeStamp);
    };
    const handleTouchEnd = (event: TouchEvent) => {
      if (!tap.end(event.touches.length, event.timeStamp)) return;
      // Keep the lifted fingers from also clicking whatever sits under them.
      if (toggleDictation() && event.cancelable) event.preventDefault();
    };

    // Capture phase so components that stop propagation still report the gesture.
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("mouseup", handleMouseUp, true);
    window.addEventListener("auxclick", handleAuxClick, true);
    window.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", handleTouchMove, { capture: true, passive: true });
    window.addEventListener("touchcancel", handleTouchCancel, { capture: true, passive: true });
    window.addEventListener("touchend", handleTouchEnd, { capture: true, passive: false });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("mouseup", handleMouseUp, true);
      window.removeEventListener("auxclick", handleAuxClick, true);
      window.removeEventListener("touchstart", handleTouchStart, true);
      window.removeEventListener("touchmove", handleTouchMove, true);
      window.removeEventListener("touchcancel", handleTouchCancel, true);
      window.removeEventListener("touchend", handleTouchEnd, true);
    };
  }, [enabled, keyboardActionDispatcher]);
}
