import type { UnistylesValues } from "react-native-unistyles";
import { CAN_HOVER } from "@/styles/hover";

/**
 * The Factory card's hover, in browser CSS (see docs/hover.md).
 *
 * The card's surface is a pressable layer behind its content, and the content is a sibling, so a
 * hovered chip or runner row is never inside the hovered surface: the surface lights only while
 * the pointer rests on empty card space. Content that also opens the overview, such as the state
 * pill and stage bar, carries the pass-through class so the surface lights for it too.
 */
const CARD_CLASS = "vorteo-hover-factory-card";
const PASS_CLASS = "vorteo-hover-factory-card-pass";

type WebStyle = NonNullable<UnistylesValues["_web"]>;
type PseudoStyle = NonNullable<WebStyle["_hover"]>;

/** The surface layer: names the card and applies `hover` while it, or a pass-through, is hovered. */
export function factoryCardSurfaceHover(hover: PseudoStyle): { _web: WebStyle } {
  const web: WebStyle = { _classNames: [CARD_CLASS] };
  if (CAN_HOVER) {
    web._hover = hover;
    const passHovered: `_has(${string})` = `_has(~ * .${PASS_CLASS}:hover)`;
    web[passHovered] = hover;
  }
  return { _web: web };
}

/** Content that opens the overview, so hovering it lights the card rather than itself. */
export const factoryCardPassThrough: { _web: WebStyle } = { _web: { _classNames: [PASS_CLASS] } };

/** Content that follows the card's hover, such as the overview button. */
export function whileFactoryCardHovered(hover: PseudoStyle): { _web?: WebStyle } {
  if (!CAN_HOVER) return {};
  const surfaceHovered: `_is(${string})` = `_is(.${CARD_CLASS}:hover ~ * *)`;
  const passHovered: `_is(${string})` = `_is(.${CARD_CLASS}:has(~ * .${PASS_CLASS}:hover) ~ * *)`;
  return { _web: { [surfaceHovered]: hover, [passHovered]: hover } };
}
