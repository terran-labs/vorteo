import { useMemo, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { useSidebarSpacing } from "@/styles/sidebar-spacing";

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
  borderless?: boolean;
  onRowLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({
  left,
  right,
  leftStyle,
  rightStyle,
  borderless,
  onRowLayout,
}: ScreenHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile = useIsCompactFormFactor();

  // The row already provides the touch target; Vorton needs only the system safe area.
  const topPadding = 0;
  const baseHorizontalPadding = isMobile ? theme.spacing[2] : theme.spacing[3];

  const innerStyle = useMemo(
    () => [styles.inner, { paddingTop: insets.top + topPadding }],
    [insets.top, topPadding],
  );
  // The sidebar's toolbar rule moves with its animated inset; a page header shares that height
  // so the two rules form one line across the window.
  const { pageHeaderHeight: headerHeight } = useSidebarSpacing();
  const rowStyle = useMemo(
    () => [styles.row, !isMobile && { height: headerHeight }, borderless && styles.borderless],
    [borderless, isMobile, headerHeight],
  );
  const leftCombinedStyle = useMemo(() => [styles.left, leftStyle], [leftStyle]);
  const rightCombinedStyle = useMemo(() => [styles.right, rightStyle], [rightStyle]);

  const HeaderBackground = View;
  return (
    <HeaderBackground style={styles.header} testID="screen-header">
      <View style={innerStyle}>
        <WindowChromeSafeArea
          placement="inline"
          horizontalPadding={baseHorizontalPadding}
          onLayout={onRowLayout}
          style={rowStyle}
        >
          <TitlebarDragRegion />
          <View style={leftCombinedStyle}>{left}</View>
          <View style={rightCombinedStyle}>{right}</View>
        </WindowChromeSafeArea>
      </View>
    </HeaderBackground>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.surface0,
  },
  inner: {},
  row: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  borderless: {
    borderBottomColor: "transparent",
  },
}));
