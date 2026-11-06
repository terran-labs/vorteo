import { FLOATING_PANEL_RADIUS } from "@/styles/floating-panel";
import { createContext, useCallback, useContext } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { ICON_SIZE } from "@/styles/theme";
import { hoverStyle } from "@/styles/hover";

export { extraMutedIconColorMapping, mutedIconColorMapping } from "@/components/ui/icon-color";

export type IconButtonChromeSize = "large" | "small";

const SMALL_ICON_BUTTON_SIZE = 20;
/** Width and height of a large icon button on compact layouts. */
export const COMPACT_LARGE_ICON_BUTTON_SIZE = 32;
const COMPACT_SMALL_ICON_BUTTON_SIZE = 32;

export interface IconButtonChromeState {
  /**
   * @deprecated Ignored. Hover is browser-owned CSS `:hover`, so the highlight clears when a click
   * moves the button out from under a resting cursor. Accepted so Pressable state objects still fit.
   */
  hovered?: boolean;
  pressed?: boolean;
  open?: boolean;
  active?: boolean;
}

function resolveIconButtonFrame(size: IconButtonChromeSize, compact: boolean) {
  if (size === "large") return styles.large;
  return compact ? styles.smallCompact : styles.small;
}

interface IconButtonChromeOptions {
  size: IconButtonChromeSize;
  state?: IconButtonChromeState;
  compact?: boolean;
  disabled?: boolean;
  /** A circular hitbox and highlight, for buttons inside a pill-shaped container. */
  round?: boolean;
  style?: StyleProp<ViewStyle>;
  /**
   * Sidebar chrome: hover and press use the sidebar rows' quiet hover fill and the current
   * page uses their selected fill, instead of the brighter shared highlight.
   */
  sidebar?: boolean;
}

/** "sidebar" gives icon actions the sidebar rows' calmer hover and selected fills. */
export type IconButtonChromeScope = "default" | "header-island" | "sidebar";

const IconButtonChromeContext = createContext<IconButtonChromeScope>("default");

/** A container owns the chrome of its icon actions, including custom menu and badge triggers. */
export const IconButtonChromeProvider = IconButtonChromeContext.Provider;

/** The same state callback works with Pressable, TooltipTrigger, and DropdownMenuTrigger. */
export function useIconButtonChromeStyle({
  size,
  compact,
  disabled,
  round,
  style,
  active,
}: Omit<IconButtonChromeOptions, "state"> & { active?: boolean }) {
  const scope = useContext(IconButtonChromeContext);
  return useCallback(
    (state: IconButtonChromeState) =>
      iconButtonChromeStyle({
        size: scope === "header-island" ? "large" : size,
        compact,
        disabled,
        round: scope === "header-island" || round,
        style,
        sidebar: scope === "sidebar",
        state: { ...state, active: active || state.active },
      }),
    [scope, size, compact, disabled, round, style, active],
  );
}

/** Shared hitbox and interaction chrome for icon-only header and toolbar controls. */
export function iconButtonChromeStyle({
  size,
  state,
  compact = false,
  disabled = false,
  round = false,
  style,
  sidebar = false,
}: IconButtonChromeOptions): StyleProp<ViewStyle> {
  return [
    resolveIconButtonFrame(size, compact),
    round ? styles.round : null,
    style,
    highlightStyle(state, sidebar, disabled),
    disabled ? styles.disabled : null,
  ];
}

/**
 * Pressed, open and active fills come from JS state; hover is a CSS `:hover` entry. `:hover`
 * outranks the base class whatever the array order, so the hover entry is left out whenever a
 * pressed, open, active or disabled fill must win.
 */
function highlightStyle(
  state: IconButtonChromeState | undefined,
  sidebar: boolean,
  disabled: boolean,
) {
  const engaged = state?.pressed || state?.open;
  if (!sidebar) {
    if (state?.active || engaged) return styles.highlighted;
    return disabled ? null : styles.highlightOnHover;
  }
  if (state?.active) return styles.sidebarSelected;
  if (engaged) return styles.sidebarHovered;
  return disabled ? null : styles.sidebarHoverOnHover;
}

/** Frame-only form for non-interactive placeholders that must preserve header alignment. */
export function iconButtonChromeFrameStyle(
  size: IconButtonChromeSize,
  compact = false,
): StyleProp<ViewStyle> {
  return resolveIconButtonFrame(size, compact);
}

export function iconButtonChromeGlyphSize(size: IconButtonChromeSize, compact = false): number {
  if (size === "large") return ICON_SIZE.md;
  return compact ? 18 : 14;
}

export function smallIconButtonChromeFrameSize(compact = false): number {
  return compact ? COMPACT_SMALL_ICON_BUTTON_SIZE : SMALL_ICON_BUTTON_SIZE;
}

const styles = StyleSheet.create((theme) => ({
  large: {
    width: {
      xs: COMPACT_LARGE_ICON_BUTTON_SIZE,
      md: HEADER_CONTROL_HEIGHT,
    },
    height: {
      xs: COMPACT_LARGE_ICON_BUTTON_SIZE,
      md: HEADER_CONTROL_HEIGHT,
    },
    padding: 0,
    borderRadius: FLOATING_PANEL_RADIUS,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  small: {
    width: SMALL_ICON_BUTTON_SIZE,
    height: SMALL_ICON_BUTTON_SIZE,
    padding: 0,
    borderRadius: FLOATING_PANEL_RADIUS,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  smallCompact: {
    width: COMPACT_SMALL_ICON_BUTTON_SIZE,
    height: COMPACT_SMALL_ICON_BUTTON_SIZE,
    padding: 0,
    borderRadius: FLOATING_PANEL_RADIUS,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  round: {
    borderRadius: theme.borderRadius.full,
  },
  highlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  highlightOnHover: hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
  sidebarHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  sidebarHoverOnHover: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
  sidebarSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
  disabled: {
    opacity: theme.opacity[50],
  },
}));
