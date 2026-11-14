import { createContext, useContext } from "react";
import { isWeb } from "@/constants/platform";

/**
 * The heading level for the next settings heading. Page groups (This device, Vorteo) are level 2
 * and section titles level 3, so content inside a section starts at 4. A group or section
 * renders its own title at the current level and gives its contents the next one, so nesting
 * and heading levels always agree.
 */
export const SettingsHeadingLevel = createContext(4);

/** The current level, capped at 6, the deepest level ARIA defines. */
export function useSettingsHeadingLevel(): number {
  return Math.min(6, useContext(SettingsHeadingLevel));
}

/** The web-only `aria-level` for a heading at `level`. */
export function webHeadingLevel(level: number) {
  return isWeb ? ({ "aria-level": level } as const) : null;
}
