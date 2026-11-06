import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";
import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { DensityIcon } from "@/components/ui/density-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { isWeb } from "@/constants/platform";
import { density, densityIconBox, densityIconProps } from "@/styles/density";
import {
  CAN_HOVER,
  groupHoverStyle,
  hoverGroup,
  hoverStyle,
  revealOnGroupHover,
} from "@/styles/hover";
import type { ShortcutKey } from "@/utils/format-shortcut";

const ROW_HOVER_GROUP = "sidebar-header-row";

type SidebarHeaderRowVariant = "header" | "compact" | "inline";

export type SidebarRowIcon = ComponentType<{ size: number; color: string }>;

/** Strokes with the CSS color of the row, so web hover can recolor it without JS state. */
function CurrentColorGlyph({ icon: Icon, size }: { icon: SidebarRowIcon; size: number }) {
  return <Icon size={size} color="currentColor" />;
}
const ThemedCurrentColorGlyph = withUnistyles(CurrentColorGlyph);
const currentColorGlyphProps = {
  md: densityIconProps("md", () => ({})),
  sm: densityIconProps("sm", () => ({})),
};

/** A caller's trailing slot wins; otherwise the shortcut hint, mounted only where it can be revealed. */
function resolveTrailing(trailing: ReactNode, shortcutKeys: ShortcutKey[][] | null | undefined) {
  if (trailing != null) return trailing;
  if (!shortcutKeys || !CAN_HOVER) return null;
  return (
    <View style={styles.shortcutReveal}>
      <Shortcut chord={shortcutKeys} />
    </View>
  );
}

interface SidebarHeaderRowProps {
  icon: SidebarRowIcon | null;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   * "inline": a full-width row with no inset, for a row inside a padded container such as the
   * sidebar footer.
   */
  variant?: SidebarHeaderRowVariant;
  borderless?: boolean;
  /** Shown in the right slot while the row is hovered, when `trailing` is not set. */
  shortcutKeys?: ShortcutKey[][] | null;
  /**
   * The right slot. A sibling of the row's button, never inside it (web cannot nest buttons). A
   * press on the slot presses the row; a button inside it presses on its own.
   */
  trailing?: ReactNode;
  rowRef?: Ref<View>;
}

export function SidebarHeaderRow({
  icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  borderless = false,
  shortcutKeys = null,
  trailing,
  rowRef,
}: SidebarHeaderRowProps) {
  const rowDensity = useSidebarRowDensity();
  // The button and its trailing slot are siblings, so the row owns the pressed fill for both.
  const [, setIsPressed] = useState(false);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const iconSize = variant === "header" ? "md" : "sm";

  // Hover is browser-owned CSS on the row's hover group. The shortcut stays mounted and CSS reveals
  // it, only where the pointer can hover, which is the only place it ever showed.
  const right = resolveTrailing(trailing, shortcutKeys);

  const rowStyle = useMemo(
    () => [
      styles.row,
      variant !== "header" && rowDensity,
      isActive ? styles.rowHighlighted : styles.rowHoverable,
    ],
    [variant, rowDensity, isActive],
  );
  return (
    <View
      ref={rowRef}
      collapsable={false}
      style={[getContainerStyle(variant), borderless && styles.borderless]}
    >
      <View style={rowStyle}>
        <Pressable
          onPress={onPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={isActive ? SELECTED_STATE : undefined}
          aria-selected={isActive}
          style={styles.button}
        >
          {icon && isWeb ? (
            <ThemedCurrentColorGlyph icon={icon} uniProps={currentColorGlyphProps[iconSize]} />
          ) : null}
          {icon && !isWeb ? (
            <DensityIcon
              icon={icon}
              size={iconSize}
              color={isActive ? "foreground" : "foregroundMuted"}
            />
          ) : null}
          {icon ? null : (
            <View style={variant === "header" ? styles.iconSpacer : styles.iconSpacerCompact} />
          )}
          <Text style={[styles.label, isActive && styles.labelHighlighted]}>{label}</Text>
        </Pressable>
        {right === null ? null : (
          <Pressable
            onPress={onPress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            accessible={false}
            focusable={false}
            style={styles.trailing}
          >
            {right}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const SELECTED_STATE = { selected: true } as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
    userSelect: "none",
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  borderless: { borderBottomWidth: 0 },
  containerInline: {
    width: "100%",
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    // Same row geometry as the settings sidebar items. Shorter than the header
    // strip so the hover highlight clears the strip's bottom separator.
    minHeight: density.tightRowHeight,
    borderRadius: theme.borderRadius.lg,
    ...hoverGroup(ROW_HOVER_GROUP),
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    _web: { color: theme.colors.foreground },
  },
  rowHoverable: hoverStyle(
    { backgroundColor: theme.colors.surfaceSidebarHover, color: theme.colors.foreground },
    { color: theme.colors.foregroundMuted },
  ),
  shortcutReveal: revealOnGroupHover(ROW_HOVER_GROUP),
  // The workspace rows' pressed fill.
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  button: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: density.tightRowHeight,
    paddingVertical: theme.spacing[1],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the list below.
    paddingHorizontal: theme.spacing[2],
  },
  iconSpacer: { width: densityIconBox("md"), height: densityIconBox("md") },
  iconSpacerCompact: { width: densityIconBox("sm"), height: densityIconBox("sm") },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    ...groupHoverStyle(ROW_HOVER_GROUP, { color: theme.colors.foreground }),
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
}));

function getContainerStyle(variant: SidebarHeaderRowVariant) {
  switch (variant) {
    case "header":
      return styles.container;
    case "compact":
      return styles.containerCompact;
    case "inline":
      return styles.containerInline;
  }
}
