import React, { useEffect } from "react";
import { View, type ActivityIndicatorProps } from "react-native";
import { VorteoLogo } from "@/components/icons/paseo-logo";
import { RadarRing } from "./radar-ring";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { PROMINENT_SPINNER_PERIOD_MS, SPINNER_PERIOD_MS } from "@/styles/spinner";
import { LOADING_INDICATOR } from "@/styles/theme";

interface LoadingSpinnerProps {
  color: string;
  size?: ActivityIndicatorProps["size"];
  style?: ActivityIndicatorProps["style"];
  /**
   * For a wait the user is watching, such as a submit button or dictation that is transcribing:
   * upstream Paseo's faster turn and a heavier ring. Leave it off for passive status.
   */
  prominent?: boolean;
}

// Upstream's ActivityIndicator ring is 4/32 of its diameter.
const PROMINENT_STROKE_RATIO = 0.125;

const brandMarkStyle = {
  position: "absolute" as const,
  width: LOADING_INDICATOR.large * 0.9,
  height: LOADING_INDICATOR.large * 0.9,
};

export function LoadingSpinner({
  color,
  size = "small",
  style,
  prominent = false,
}: LoadingSpinnerProps) {
  const baseDiameter = typeof size === "number" ? size : LOADING_INDICATOR[size];
  const diameter = size === "large" ? baseDiameter * 1.25 : baseDiameter;
  const passiveStroke =
    diameter >= 32
      ? LOADING_INDICATOR.largeStroke
      : Math.min(LOADING_INDICATOR.smallStroke, diameter / 10);
  const stroke = prominent ? diameter * PROMINENT_STROKE_RATIO : passiveStroke;
  const period = prominent ? PROMINENT_SPINNER_PERIOD_MS : SPINNER_PERIOD_MS;
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = 0;
    rotation.value = withRepeat(withTiming(360, { duration: period, easing: Easing.linear }), -1);
    return () => cancelAnimation(rotation);
  }, [period, rotation]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return (
    <View
      role="progressbar"
      accessibilityLabel="Loading"
      style={[{ alignItems: "center", justifyContent: "center" }, style]}
    >
      {size === "large" ? (
        <View testID="loading-brand-mark" style={brandMarkStyle}>
          <VorteoLogo size={LOADING_INDICATOR.large * 0.9} />
        </View>
      ) : null}
      {/* Keep theme props off the animated carrier so native theme changes remain safe. */}
      <Animated.View style={[{ width: diameter, height: diameter }, animatedStyle]}>
        <RadarRing size={diameter} strokeWidth={stroke} color={color} />
      </Animated.View>
    </View>
  );
}
