import type { AccessibilityRole, AccessibilityState, Role } from "react-native";

/** The ARIA state props React Native accepts on every platform. */
export interface AriaStateProps {
  "aria-busy"?: boolean;
  "aria-checked"?: boolean | "mixed";
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
  "aria-selected"?: boolean;
}

const SELECTABLE_ROLES: ReadonlySet<string> = new Set([
  "option",
  "tab",
  "row",
  "gridcell",
  "cell",
  "columnheader",
  "rowheader",
  "treeitem",
]);

const CHECKABLE_ROLES: ReadonlySet<string> = new Set([
  "checkbox",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "switch",
]);

/**
 * react-native-web 0.21 ignores `accessibilityState` apart from `disabled`, so a busy, expanded,
 * selected or checked control says nothing on web. This mirrors the state as ARIA props, which
 * every platform reads. A checked state on a button becomes `aria-pressed`, the toggle-button
 * form; checkable roles keep `aria-checked`. Explicit ARIA props from the caller still win.
 */
export function ariaFromAccessibilityState(
  state: AccessibilityState | undefined,
  role: AccessibilityRole | Role | undefined,
): AriaStateProps {
  if (!state) return {};
  const aria: AriaStateProps = {};
  if (state.busy !== undefined) aria["aria-busy"] = state.busy;
  if (state.expanded !== undefined) aria["aria-expanded"] = state.expanded;
  // ARIA allows `aria-selected` only on options, tabs, rows and cells; a selected button is a
  // pressed toggle.
  if (state.selected !== undefined) {
    if (role && SELECTABLE_ROLES.has(role)) aria["aria-selected"] = state.selected;
    else if (role === "button" || role === "togglebutton") aria["aria-pressed"] = state.selected;
  }
  if (state.checked !== undefined) {
    if (role && CHECKABLE_ROLES.has(role)) aria["aria-checked"] = state.checked;
    else if (typeof state.checked === "boolean") aria["aria-pressed"] = state.checked;
  }
  return aria;
}
