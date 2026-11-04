import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SidebarSectionRow } from "@/components/sidebar/container-row";
import { SidebarPinIcon } from "@/components/sidebar/leading-slot";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { SidebarFocusButton } from "@/sidebar-focus/focus-button";
import { useSidebarFocusAction } from "@/sidebar-focus/context";
import type { SidebarFocusTarget } from "@/sidebar-focus/model";
import { useVortonTouch } from "@/vorton-touch";

const PINNED_FOCUS_TARGET: SidebarFocusTarget = { kind: "pinned" };
const pinnedSectionIcon = <SidebarPinIcon />;

/**
 * The root Pinned heading: a folder-like row that folds, and focuses to list only pinned rows.
 * Outside a focus provider, as in status grouping, it shows no focus button.
 */
export function PinnedSectionRow({
  count,
  collapsed,
  onToggle,
}: {
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  const title = t("sidebar.pinned.title");
  const focusAction = useSidebarFocusAction(PINNED_FOCUS_TARGET);
  // Pinned has no menu, so touch layouts keep the focus button visible.
  const hoverUnavailable = touch || compact || isNative;
  const trailing = useCallback(
    (isHovered: boolean) =>
      focusAction && (isHovered || hoverUnavailable) ? (
        <SidebarFocusButton
          name={title}
          onPress={focusAction}
          testID="sidebar-pinned-section-header-focus"
        />
      ) : null,
    [focusAction, hoverUnavailable, title],
  );
  return (
    <SidebarSectionRow
      title={title}
      icon={pinnedSectionIcon}
      count={count}
      collapsed={collapsed}
      onToggle={onToggle}
      level={0}
      testID="sidebar-pinned-section-header"
      trailing={trailing}
    />
  );
}
