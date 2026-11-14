import { useCallback, useMemo } from "react";
import {
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { switchGeometryForLayout, type SwitchGeometry } from "@/components/ui/control-geometry";
import { useContainedControlSize } from "@/components/ui/control-size";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHiddenDescription } from "./visually-hidden";
import type { Theme } from "@/styles/theme";

interface SwitchProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Explains the effect, such as a row hint; announced after the label. */
  accessibilityHint?: string;
  /** Marks a change in flight, such as while the new value saves. */
  "aria-busy"?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const TRACK_BORDER = 1;
const TIMING = { duration: 180, easing: Easing.inOut(Easing.ease) };

interface SwitchTrackProps {
  value: boolean;
  geometry: SwitchGeometry;
  trackOffColor: string;
  trackOnColor: string;
  trackOffBorderColor: string;
  thumbOffColor: string;
  thumbOnColor: string;
}

function SwitchTrack({
  value,
  geometry,
  trackOffColor,
  trackOnColor,
  trackOffBorderColor,
  thumbOffColor,
  thumbOnColor,
}: SwitchTrackProps) {
  const progress = useDerivedValue(() => withTiming(value ? 1 : 0, TIMING));

  const trackAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [trackOffColor, trackOnColor]),
    // The off track's fill nearly matches the card, so its outline carries the 3:1 boundary.
    borderColor: interpolateColor(progress.value, [0, 1], [trackOffBorderColor, trackOnColor]),
  }));

  const { thumbTravel } = geometry;
  const thumbAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [thumbOffColor, thumbOnColor]),
    transform: [{ translateX: progress.value * thumbTravel }],
  }));

  const trackSize = useMemo(
    () => ({
      width: geometry.trackWidth,
      height: geometry.trackHeight,
      borderRadius: geometry.trackHeight / 2,
      borderWidth: TRACK_BORDER,
      // The border sits inside the track, so the thumb keeps its size and travel.
      padding: (geometry.trackHeight - geometry.thumbSize) / 2 - TRACK_BORDER,
    }),
    [geometry],
  );
  const thumbSize = useMemo(
    () => ({
      width: geometry.thumbSize,
      height: geometry.thumbSize,
      borderRadius: geometry.thumbSize / 2,
    }),
    [geometry],
  );
  const trackStyle = useMemo(
    () => [styles.switchTrack, trackSize, trackAnimatedStyle],
    [trackSize, trackAnimatedStyle],
  );
  const thumbStyle = useMemo(
    () => [thumbSize, styles.thumb, thumbAnimatedStyle],
    [thumbSize, thumbAnimatedStyle],
  );

  return (
    <Animated.View style={trackStyle}>
      <Animated.View style={thumbStyle} />
    </Animated.View>
  );
}

const ThemedSwitchTrack = withUnistyles(SwitchTrack, (theme: Theme) => ({
  trackOffColor: theme.colors.surface3,
  trackOnColor: theme.colors.accent,
  trackOffBorderColor: theme.colors.foregroundExtraMuted,
  thumbOffColor: theme.colors.palette.white,
  thumbOnColor: theme.colors.accentForeground,
}));

export function Switch({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  "aria-busy": ariaBusy,
  testID,
  style,
}: SwitchProps) {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (disabled) return;
      onValueChange?.(!value);
    },
    [disabled, onValueChange, value],
  );

  const size = useContainedControlSize() ?? "md";
  const isCompact = useIsCompactFormFactor();
  const geometry = useMemo(() => switchGeometryForLayout(size, isCompact), [size, isCompact]);

  const accessibilityState = useMemo(
    () => ({ checked: value, disabled, ...(ariaBusy !== undefined ? { busy: ariaBusy } : {}) }),
    [value, disabled, ariaBusy],
  );
  const pressableStyle = useMemo(
    () => [
      styles.switchControl,
      { minHeight: geometry.reservedHeight },
      disabled ? styles.disabled : null,
      style,
    ],
    [disabled, geometry.reservedHeight, style],
  );

  const description = useHiddenDescription(accessibilityHint);
  const control = (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      {...description.props}
      aria-checked={value}
      aria-disabled={disabled}
      aria-busy={ariaBusy}
      testID={testID}
      style={pressableStyle}
    >
      <ThemedSwitchTrack value={value} geometry={geometry} />
    </Pressable>
  );
  if (!description.node) return control;
  return (
    <>
      {control}
      {description.node}
    </>
  );
}

const styles = StyleSheet.create((theme) => {
  return {
    switchControl: {
      justifyContent: "center",
    },
    switchTrack: {
      justifyContent: "center",
    },
    thumb: {
      shadowColor: "rgba(0, 0, 0, 0.25)",
      shadowOffset: { width: 0, height: 1 },
      shadowRadius: 2,
      shadowOpacity: 1,
      elevation: 2,
    },
    disabled: {
      opacity: theme.opacity[50],
    },
  };
});
