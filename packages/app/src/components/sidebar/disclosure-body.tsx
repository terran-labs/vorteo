import { useCallback, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { isWeb } from "@/constants/platform";

export const SIDEBAR_DISCLOSURE_DURATION = 180;
const bodyStyle = { flexShrink: 0 } as const;

/** Retain body measurements so every sidebar disclosure closes as quickly as it opens. */
export function SidebarDisclosureBody({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  const [height, setHeight] = useState<number | null>(null);
  const measure = useCallback((event: LayoutChangeEvent) => {
    setHeight(event.nativeEvent.layout.height);
  }, []);
  const animatedStyle = useAnimatedStyle(
    () => ({
      height:
        height === null && expanded
          ? undefined
          : withTiming(expanded ? (height ?? 0) : 0, {
              duration: SIDEBAR_DISCLOSURE_DURATION,
              easing: Easing.out(Easing.cubic),
              reduceMotion: ReduceMotion.System,
            }),
      overflow: "hidden" as const,
      flexShrink: 1,
      minHeight: 0,
    }),
    [expanded, height],
  );
  return (
    <Animated.View
      style={animatedStyle}
      pointerEvents={expanded ? "auto" : "none"}
      accessibilityElementsHidden={!expanded}
      importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
      {...(isWeb ? { inert: !expanded } : {})}
    >
      <View onLayout={measure} style={bodyStyle}>
        {children}
      </View>
    </Animated.View>
  );
}
