import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { VORTON_HEADER_HEIGHT } from "@/constants/layout";
import { FLOATING_PANEL_INSET } from "@/styles/floating-panel";

/** The floating sidebar's border, above its padding. */
const SIDEBAR_BORDER_WIDTH = 1;

/**
 * Where the sidebar's toolbar rule falls from the window's top: the floating panel's offset, its
 * border, its animated inset, then the toolbar. Page headers end exactly there.
 */
function pageHeaderHeightFor(inset: number): number {
  return FLOATING_PANEL_INSET + SIDEBAR_BORDER_WIDTH + inset + VORTON_HEADER_HEIGHT;
}
import { panelHeaderInset, usePanelSpacing } from "./use-panel-spacing";

const SidebarSpacingContext = createContext({
  inset: 2,
  headerHeight: VORTON_HEADER_HEIGHT + 4,
  pageHeaderHeight: pageHeaderHeightFor(2),
  onLayout: (_event: LayoutChangeEvent) => {},
  setCompact: (_compact: boolean) => {},
});

/** One animation clock keeps navigation padding, tabs and workspace actions aligned. */
export function SidebarSpacingProvider({ children }: { children: ReactNode }) {
  const { inset, onLayout } = usePanelSpacing();
  const [compact, setCompact] = useState(false);
  const value = useMemo(
    () => ({
      inset,
      headerHeight: VORTON_HEADER_HEIGHT + (compact ? 0 : panelHeaderInset(inset) * 2),
      pageHeaderHeight: pageHeaderHeightFor(inset),
      onLayout,
      setCompact,
    }),
    [inset, onLayout, compact],
  );
  return <SidebarSpacingContext.Provider value={value}>{children}</SidebarSpacingContext.Provider>;
}

export const useSidebarSpacing = () => useContext(SidebarSpacingContext);
