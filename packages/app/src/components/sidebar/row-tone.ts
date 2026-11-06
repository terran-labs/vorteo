import { createContext, useContext } from "react";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

/**
 * One color for every single-color icon in a sidebar row, so the status icon on the left and the
 * host, lock and schedule marks on the right read as one tone with the title. A calm row uses the
 * extra-muted color; a row that wants attention uses the title's foreground at its opacity.
 * Null outside a sidebar row, where icons keep their own colors.
 */
export type SidebarRowTone = "calm" | "lit";

export const SidebarRowToneContext = createContext<SidebarRowTone | null>(null);

export function useSidebarRowTone(): SidebarRowTone | null {
  return useContext(SidebarRowToneContext);
}

/** The title's opacity on a lit row; icons sit at the same strength. */
export const SIDEBAR_LIT_OPACITY = 0.76;

export function sidebarRowToneColor(theme: Theme, tone: SidebarRowTone): string {
  return tone === "calm" ? theme.colors.foregroundExtraMuted : theme.colors.foreground;
}

/**
 * On web a calm icon paints `currentColor`, and the row sets the CSS `color` around it: the calm
 * color at rest and the lit color while CSS reports the row hovered, so the icon lifts without a
 * JS hover flag. Use it only inside an element that sets `color`, as the workspace row does.
 */
export const calmToneColor = (theme: Theme) => ({
  color: isWeb ? "currentColor" : sidebarRowToneColor(theme, "calm"),
});
export const litToneColor = (theme: Theme) => ({ color: sidebarRowToneColor(theme, "lit") });
