import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Folder, Pin } from "lucide-react-native";
import { CAN_HOVER, groupHoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";

export type SidebarDisclosure = "expand" | "collapse" | null;

// Matches the workspace title's line box, so the slot centers on the title like the workspace
// status slot does.
const LEADING_SLOT_HEIGHT = 20;

const ThemedFolder = withUnistyles(Folder);
const ThemedPin = withUnistyles(Pin);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const calmColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/**
 * Hover group a container row joins (alongside its own) so its leading slot follows CSS hover.
 * Pass it to `hoverGroup([rowGroup, SIDEBAR_LEADING_HOVER_GROUP])` and set `cssHover` on the slot
 * and folder icon.
 */
export const SIDEBAR_LEADING_HOVER_GROUP = "sidebar-leading";

/**
 * The leading slot every sidebar container row shares: projects, folders, Standing and Factory.
 * It shows the row's icon at rest and swaps in the disclosure arrow on pointer hover: touch
 * layouts keep the icon, and tapping the row still folds it. A row without an icon keeps its
 * arrow visible.
 *
 * With `cssHover`, both stay mounted and the browser's `:hover` on the row's
 * {@link SIDEBAR_LEADING_HOVER_GROUP} swaps them, so the arrow cannot stick after layout moves the
 * row from under a resting cursor. Without it, or without a hover-capable pointer, the icon stays.
 */
export function SidebarLeadingSlot({
  chevron,
  cssHover = false,
  children,
  testID,
}: {
  chevron: SidebarDisclosure;
  cssHover?: boolean;
  children: ReactNode;
  testID?: string;
}) {
  const hasIcon = children !== null && children !== undefined && children !== false;
  if (chevron !== null && hasIcon && cssHover && CAN_HOVER) {
    return (
      <View style={styles.slot} testID={testID}>
        <View style={styles.iconAtRest}>{children}</View>
        <View style={styles.chevronOnHover}>
          <SidebarDisclosureChevron chevron={chevron} />
        </View>
      </View>
    );
  }
  const showChevron = chevron !== null && !hasIcon;
  return (
    <View style={styles.slot} testID={testID}>
      {showChevron ? <SidebarDisclosureChevron chevron={chevron} /> : children}
    </View>
  );
}

function SidebarDisclosureChevron({ chevron }: { chevron: "expand" | "collapse" }) {
  if (chevron === "collapse") {
    return <ChevronDown size={14} color="#9ca3af" />;
  }
  return <ChevronRight size={14} color="#9ca3af" />;
}

/**
 * The folder glyph for folders, Standing and Factory: the workspace kind icon's size. With
 * `cssHover` on web it paints through CSS `color` and `currentColor`, so the row's
 * {@link SIDEBAR_LEADING_HOVER_GROUP} can swap it for the arrow; hover never brightens it.
 */
export function SidebarFolderIcon({
  calm = false,
  cssHover = false,
}: { calm?: boolean; cssHover?: boolean } = {}) {
  if (cssHover && CAN_HOVER) {
    return (
      <View style={calm ? styles.calmGlyph : styles.mutedGlyph}>
        <Folder size={14} color="currentColor" />
      </View>
    );
  }
  return <ThemedFolder size={14} uniProps={calm ? calmColorMapping : mutedColorMapping} />;
}

/**
 * The Pinned section's glyph, sized like the folder glyph so the section reads as a root folder.
 * Takes the same `calm` and `cssHover` options as {@link SidebarFolderIcon}.
 */
export function SidebarPinIcon({
  calm = false,
  cssHover = false,
}: { calm?: boolean; cssHover?: boolean } = {}) {
  if (cssHover && CAN_HOVER) {
    return (
      <View style={calm ? styles.calmGlyph : styles.mutedGlyph}>
        <Pin size={14} color="currentColor" />
      </View>
    );
  }
  return <ThemedPin size={14} uniProps={calm ? calmColorMapping : mutedColorMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    width: theme.iconSize.md,
    height: LEADING_SLOT_HEIGHT,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  iconAtRest: {
    alignItems: "center",
    justifyContent: "center",
    ...groupHoverStyle(SIDEBAR_LEADING_HOVER_GROUP, { display: "none" }),
  },
  chevronOnHover: {
    display: "none",
    ...groupHoverStyle(SIDEBAR_LEADING_HOVER_GROUP, { display: "flex" }),
  },
  mutedGlyph: { _web: { color: theme.colors.foregroundMuted } },
  // Calm stays calm on hover: brighter glyphs are kept for things to review.
  calmGlyph: { _web: { color: theme.colors.foregroundExtraMuted } },
}));
