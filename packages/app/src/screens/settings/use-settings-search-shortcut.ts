import { useEffect } from "react";
import { isWeb } from "@/constants/platform";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * "/" focuses settings search on web, unless the reader is already typing.
 * Other shortcuts keep their meaning, so Command/Ctrl+F still finds in page.
 */
export function useSettingsSearchShortcut(): void {
  useEffect(() => {
    if (!isWeb || typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target)) return;
      // The phone stack retains its index behind a section. Focus the visible header,
      // not the earlier input in that hidden route.
      const input = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="settings-search-input"]'),
      ).find(
        (candidate) =>
          candidate.getClientRects().length > 0 && !candidate.closest('[aria-hidden="true"]'),
      );
      if (!input) return;
      event.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
