import type { UnistylesValues } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

/**
 * Browser-owned hover for purely visual highlights. See docs/hover.md.
 *
 * The browser recomputes `:hover` when layout moves an element out from under a resting cursor,
 * while JS hover flags (`onPointerEnter`, `Pressable` `hovered`, `onHoverIn`) only update when the
 * pointer moves, so a card that collapses under the cursor keeps its highlight. Unistyles compiles
 * `_web._hover` to a real `:hover` rule on the element's class.
 *
 * Touch screens keep `:hover` after a tap, so the rule is emitted only when the primary pointer
 * can hover. That is a load-time capability check: attaching a mouse to a tablet takes a reload.
 * CSS `:hover` outranks the element's base class regardless of style array order, so suppress the
 * highlight for selected or disabled states by leaving the hover style out of the array.
 */
export const CAN_HOVER =
  isWeb && typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches === true;

/** Everything a Unistyles style accepts under `_web`, including pseudo-class keys. */
type WebStyle = NonNullable<UnistylesValues["_web"]>;
/** The declarations inside one pseudo-class, such as `_hover`. */
type PseudoStyle = NonNullable<WebStyle["_hover"]>;

/**
 * Style fragment that applies `hover` while the browser reports the element hovered. Pass any
 * other web-only declarations for the same style as `web`, since a style has one `_web` key.
 */
export function hoverStyle(hover: PseudoStyle, web?: WebStyle): { _web?: WebStyle } {
  if (!CAN_HOVER) return web ? { _web: web } : {};
  return { _web: { ...web, _hover: hover } };
}

/**
 * Marks an element as a named hover group, so a descendant can react to the whole row being
 * hovered with {@link groupHoverStyle}. Name groups by role, such as "row", so a reveal inside
 * nested groups follows the group it belongs to. Pass several names for an element in several groups.
 */
export function hoverGroup(name: string | readonly string[], web?: WebStyle): { _web: WebStyle } {
  // One style carries one `_classNames`, so an element in several groups lists them together.
  const names = typeof name === "string" ? [name] : name;
  return { _web: { ...web, _classNames: names.map((group) => `vorteo-hover-${group}`) } };
}

/**
 * Style fragment applied while any ancestor marked `hoverGroup(name)` is hovered. CSS cannot pick
 * the nearest group, so give nested groups different names.
 */
export function groupHoverStyle(
  name: string,
  hover: PseudoStyle,
  web?: WebStyle,
): { _web?: WebStyle } {
  if (!CAN_HOVER) return web ? { _web: web } : {};
  const selector: `_is(${string})` = `_is(.vorteo-hover-${name}:hover *)`;
  return { _web: { ...web, [selector]: hover } };
}

/**
 * Keeps controls mounted but invisible and click-through until their `hoverGroup(name)` ancestor
 * is hovered or holds keyboard focus (`:focus-visible`, so a mouse click does not pin it). Returns no style without hover, so touch layouts always
 * show the controls; also leave it out of the style array for compact layouts.
 */
export function revealOnGroupHover(name: string): {
  opacity?: number;
  _web?: WebStyle;
} {
  if (!CAN_HOVER) return {};
  const shown: PseudoStyle = { opacity: 1, pointerEvents: "auto" };
  const hovered: `_is(${string})` = `_is(.vorteo-hover-${name}:hover *)`;
  // Keyboard focus only: a mouse click focuses the row, which must not pin its actions open.
  const focused: `_is(${string})` = `_is(.vorteo-hover-${name}:has(:focus-visible) *)`;
  const web: WebStyle = { pointerEvents: "none" };
  web[hovered] = shown;
  web[focused] = shown;
  web["_has(:focus-visible)"] = shown;
  return { opacity: 0, _web: web };
}

/**
 * CSS custom property a row sets to the surface it currently shows. Knockout marks inside it, such
 * as status-ring halos and badge cutouts, paint this color so they match the row's hover fill
 * without a JS hover flag. Custom properties inherit, so the nearest row that sets it wins.
 */
export const ROW_SURFACE_VAR = "--vorteo-row-surface";

/**
 * A row's hover fill that also publishes {@link ROW_SURFACE_VAR}: `rest` at rest (the surface the
 * row sits on), `hover` while hovered. Use instead of `hoverStyle({ backgroundColor })` on rows
 * that contain knockout marks.
 */
export function hoverSurface(rest: string, hover: string, web?: WebStyle): { _web: WebStyle } {
  // Custom properties are outside the typed CSS keys, so build loosely and cast once.
  const style: Record<string, unknown> = { ...web, [ROW_SURFACE_VAR]: rest };
  if (CAN_HOVER) style._hover = { backgroundColor: hover, [ROW_SURFACE_VAR]: hover };
  return { _web: style as WebStyle };
}

/** Publishes a fixed {@link ROW_SURFACE_VAR}, for selected or pressed rows whose fill wins over hover. */
export function rowSurface(color: string): { _web: WebStyle } {
  return { _web: { [ROW_SURFACE_VAR]: color } as WebStyle };
}

/** Background for a knockout mark: the nearest row's published surface, else `fallback`. */
export function followRowSurface(fallback: string): { backgroundColor: string; _web: WebStyle } {
  return {
    backgroundColor: fallback,
    _web: { backgroundColor: `var(${ROW_SURFACE_VAR}, ${fallback})` },
  };
}

/**
 * Group-hover fill that also publishes {@link ROW_SURFACE_VAR}, for chips whose hover belongs to
 * a wider frame (such as a tab and its sibling close button). `surface` is the token color the
 * knockout marks inside should paint, which can differ from the visible `fill`.
 */
export function groupHoverSurface(name: string, fill: string, surface = fill): { _web?: WebStyle } {
  if (!CAN_HOVER) return {};
  const selector: `_is(${string})` = `_is(.vorteo-hover-${name}:hover *)`;
  return {
    _web: { [selector]: { backgroundColor: fill, [ROW_SURFACE_VAR]: surface } } as WebStyle,
  };
}
