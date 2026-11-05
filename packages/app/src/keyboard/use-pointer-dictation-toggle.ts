import { useEffect } from "react";

import { isWeb } from "@/constants/platform";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";

const TOGGLE_CLICK_COUNT = 3;
const MIDDLE_BUTTON = 1;

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

/**
 * Terminals and text fields other than the message field keep the browser's
 * native triple click, which selects a line or paragraph.
 */
export function shouldPointerToggleDictation(target: EventTarget | null): boolean {
  if (!isElement(target)) return true;
  if (target.closest("[data-testid='terminal-surface'], .xterm, .cm-editor")) return false;
  if (target.closest("[data-testid='message-input-root']")) return true;
  const editable = target.closest("input, textarea, select, [contenteditable='true']");
  return editable === null;
}

/** Links keep middle click, which opens them in a new tab. */
export function shouldMiddleClickToggleDictation(target: EventTarget | null): boolean {
  return !isElement(target) || target.closest("a[href]") === null;
}

/**
 * A triple click anywhere in the window starts dictation in the active message
 * field, and the next triple click stops it and inserts the transcript for
 * editing. A single middle click does the same.
 *
 * Built for a lone trackpad, such as a Magic Trackpad with an iPad or Mac.
 * Browsers never report how many fingers touch a trackpad, so a three-finger
 * tap only reaches the page when the operating system turns it into a middle
 * click: on a Mac through a helper such as MiddleClick, and on Android tablets
 * through the touchpad's three-finger tap setting. iPadOS offers no such
 * mapping. Touchscreen taps are ignored.
 */
export function usePointerDictationToggle(enabled: boolean): void {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();

  useEffect(() => {
    if (!isWeb || !enabled || typeof window === "undefined") return;
    let lastPointerType = "mouse";

    const handlePointerDown = (event: PointerEvent) => {
      lastPointerType = event.pointerType;
    };
    const isToggleClick = (event: MouseEvent) =>
      event.button === 0 &&
      event.detail === TOGGLE_CLICK_COUNT &&
      lastPointerType !== "touch" &&
      shouldPointerToggleDictation(event.target);

    // Stop the third press from selecting a paragraph under the pointer.
    const isToggleMiddleClick = (event: MouseEvent) =>
      event.button === MIDDLE_BUTTON &&
      lastPointerType !== "touch" &&
      shouldMiddleClickToggleDictation(event.target);
    const toggleDictation = () =>
      keyboardActionDispatcher.dispatch({
        id: "message-input.dictation-insert-toggle",
        scope: "message-input",
      });

    // Stop the third press from selecting a paragraph, and a middle press from
    // starting autoscroll.
    const handleMouseDown = (event: MouseEvent) => {
      if (isToggleClick(event) || isToggleMiddleClick(event)) event.preventDefault();
    };
    // Safari has no auxclick, so the middle button toggles on release.
    const handleMouseUp = (event: MouseEvent) => {
      if (isToggleMiddleClick(event) && toggleDictation()) event.preventDefault();
    };
    const handleAuxClick = (event: MouseEvent) => {
      if (isToggleMiddleClick(event)) event.preventDefault();
    };
    const handleClick = (event: MouseEvent) => {
      if (!isToggleClick(event)) return;
      if (!toggleDictation()) return;
      event.preventDefault();
      // The first two presses may have selected a word; drop it.
      if (!isElement(event.target) || !event.target.closest("[data-testid='message-input-root']")) {
        window.getSelection()?.removeAllRanges();
      }
    };

    // Capture phase so components that stop propagation still report the gesture.
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("mouseup", handleMouseUp, true);
    window.addEventListener("auxclick", handleAuxClick, true);
    window.addEventListener("click", handleClick, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("mouseup", handleMouseUp, true);
      window.removeEventListener("auxclick", handleAuxClick, true);
      window.removeEventListener("click", handleClick, true);
    };
  }, [enabled, keyboardActionDispatcher]);
}
