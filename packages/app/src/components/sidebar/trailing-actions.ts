import { StyleSheet } from "react-native-unistyles";
import { hoverStyle } from "@/styles/hover";

/**
 * The right-hand action rail of a sidebar row: focus, ⋮ and similar icon controls. Pair `kebab`
 * with `useSidebarActionSize()` so each control is a fixed, centered box (44px on touch), and add
 * `railTouch` on touch layouts.
 */
export const sidebarTrailingActionStyles = StyleSheet.create((theme) => ({
  rail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    // MoreVertical paints only around the center of its 14px SVG. Pull the painted edge through
    // the unused view-box space onto the row rail, as project rows do.
    marginRight: -6,
  },
  // Touch boxes are 44px, wider than the glyph by far more than the view-box slack. Cancel the
  // container row's right padding instead, so the boxes end on the toolbar buttons' rail.
  railTouch: {
    marginRight: -theme.spacing[2],
  },
  kebab: {
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    // The kebab strokes with this color on web.
    ...hoverStyle(
      { backgroundColor: theme.colors.surface2, color: theme.colors.foreground },
      { color: theme.colors.foregroundMuted },
    ),
  },
}));
