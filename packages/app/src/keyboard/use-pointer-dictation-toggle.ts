import { useEffect } from "react";

import { isWeb } from "@/constants/platform";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";

const TOGGLE_CLICK_COUNT = 3;

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

/**
 * A triple click anywhere in the window starts dictation in the active message
 * field, and the next triple click stops it and inserts the transcript for
 * editing. Built for a lone trackpad, such as a Magic Trackpad with an iPad or
 * Mac. Touchscreen taps are ignored; browsers do not report trackpad finger
 * counts, so multi-finger taps cannot be detected here.
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
    const handleMouseDown = (event: MouseEvent) => {
      if (isToggleClick(event)) event.preventDefault();
    };
    const handleClick = (event: MouseEvent) => {
      if (!isToggleClick(event)) return;
      const handled = keyboardActionDispatcher.dispatch({
        id: "message-input.dictation-insert-toggle",
        scope: "message-input",
      });
      if (!handled) return;
      event.preventDefault();
      // The first two presses may have selected a word; drop it.
      if (!isElement(event.target) || !event.target.closest("[data-testid='message-input-root']")) {
        window.getSelection()?.removeAllRanges();
      }
    };

    // Capture phase so components that stop propagation still report the gesture.
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("click", handleClick, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("click", handleClick, true);
    };
  }, [enabled, keyboardActionDispatcher]);
}
