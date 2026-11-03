import type { KeyboardShortcutInput } from "../keyboard-shortcuts";

export interface KeyboardInputEvent extends KeyboardShortcutInput {
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
export interface OverlayEntry {
  getLayer(): number;
  getFocusBehavior?(): "trap" | "none";
  getKeys(): readonly string[];
  onKeyDown(event: KeyboardInputEvent): boolean;
}
export function createOverlayRegistry() {
  const entries: OverlayEntry[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  function getTop(interactiveOnly = false): OverlayEntry | undefined {
    let top: OverlayEntry | undefined;
    for (const entry of entries) {
      if (interactiveOnly && entry.getFocusBehavior?.() === "none") continue;
      if (!top || entry.getLayer() >= top.getLayer()) top = entry;
    }
    return top;
  }
  return {
    getTop,
    getKeys: () => {
      const top = getTop();
      const interactive = getTop(true);
      return [...new Set([...(top?.getKeys() ?? []), ...(interactive?.getKeys() ?? [])])];
    },
    hasActive: () => getTop(true) !== undefined,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(entry: OverlayEntry) {
      entries.push(entry);
      notify();
      return () => {
        const index = entries.indexOf(entry);
        if (index < 0) return;
        entries.splice(index, 1);
        notify();
      };
    },
    dispatch(event: KeyboardInputEvent): boolean {
      if (event.isComposing || event.key === "Process") return false;
      const top = getTop();
      let handled = top?.onKeyDown(event) ?? false;
      if (!handled && top?.getFocusBehavior?.() === "none") {
        handled = getTop(true)?.onKeyDown(event) ?? false;
      }
      if (!handled) return false;
      event.stopPropagation();
      return true;
    },
  };
}
export const overlays = createOverlayRegistry();
