import { hoverStyle } from "./hover";
import type { Theme } from "./theme";

/** Floating navigation controls share the same surface, outline and soft elevation. */
export function floatingControlSurface(theme: Theme) {
  return {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    ...theme.shadow.sm,
  };
}

/**
 * Hover for a floating control drawn with a button variant. Button hovers use `surface4`, which
 * appearance and plugin themes make translucent, so content scrolling under the control would
 * show through. This keeps the control's resting background and paints the tint over it as a
 * layer, so hover is never more translucent than rest.
 */
export function floatingControlHover(theme: Theme) {
  const tint = theme.colors.surface4;
  return hoverStyle({
    backgroundColor: theme.colors.surface2,
    backgroundImage: `linear-gradient(${tint}, ${tint})`,
    borderColor: theme.colors.border,
  });
}
