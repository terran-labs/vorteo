import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { AppWindowMac } from "lucide-react-native";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import type { AgentControlIcon, AgentControlIconProps } from "@/agent-controls/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RadarRing } from "@/components/ui/radar-ring";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { SPINNER_PERIOD_MS } from "@/styles/spinner";

export const THREAD_CHROME_FEATURE_ID = "chrome";

/** Clears a pending change whose confirmation never arrives, so the switch can't stay stuck. */
const PENDING_TIMEOUT_MS = 20_000;

/** The thread's Chrome toggle, when its provider offers one on this machine. */
export function findThreadChromeFeature(
  features: AgentFeature[] | undefined,
): Extract<AgentFeature, { type: "toggle" }> | null {
  const feature = features?.find((entry) => entry.id === THREAD_CHROME_FEATURE_ID);
  return feature?.type === "toggle" ? feature : null;
}

/** A browser glyph, shrunk inside a spinning ring while a change is in flight. */
function ChromeSwitchIcon({ size, color, pending }: AgentControlIconProps & { pending: boolean }) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    if (!pending) return undefined;
    rotation.value = 0;
    rotation.value = withRepeat(
      withTiming(360, { duration: SPINNER_PERIOD_MS, easing: Easing.linear }),
      -1,
    );
    return () => cancelAnimation(rotation);
  }, [pending, rotation]);
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  if (!pending) return <AppWindowMac size={size} color={color} />;

  const ringSize = size + 4;
  return (
    <View style={[styles.pendingGlyph, { width: size, height: size }]}>
      <AppWindowMac size={Math.round(size * 0.6)} color={color} />
      <Animated.View
        style={[styles.ring, { width: ringSize, height: ringSize, top: -2, left: -2 }, ringStyle]}
      >
        <RadarRing size={ringSize} strokeWidth={1.5} color={color} />
      </Animated.View>
    </View>
  );
}

/**
 * Profile-based composers replace the per-thread controls that normally list provider
 * features, so Chrome gets its own switch beside the profile picker. It changes only this
 * thread and never saves Chrome as a provider default: the owner opts in each thread.
 *
 * The daemon confirms a change by sending the thread's updated features, which can lag the
 * tap. Until that arrives the switch shows a spinner and ignores further presses, so a
 * second tap can't silently undo the first.
 */
export function ThreadChromeSwitch({
  visible,
  features,
  disabled,
  setFeature,
}: {
  visible: boolean;
  features: AgentFeature[] | undefined;
  disabled: boolean;
  setFeature: (featureId: string, value: unknown) => Promise<unknown> | undefined;
}) {
  const toast = useToast();
  const feature = findThreadChromeFeature(features);
  const enabled = feature?.value === true;
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const pending = pendingValue !== null;

  useEffect(() => {
    if (pendingValue === null) return undefined;
    if (enabled === pendingValue) {
      setPendingValue(null);
      return undefined;
    }
    const timer = setTimeout(() => setPendingValue(null), PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [enabled, pendingValue]);

  const handlePress = useCallback(() => {
    if (pending) return;
    const next = !enabled;
    setPendingValue(next);
    const request = setFeature(THREAD_CHROME_FEATURE_ID, next);
    if (!request) {
      setPendingValue(null);
      return;
    }
    void request.catch((error: unknown) => {
      console.warn("[ThreadChromeSwitch] setAgentFeature failed", error);
      setPendingValue(null);
      toast.error(toErrorMessage(error));
    });
  }, [enabled, pending, setFeature, toast]);

  const icon = useMemo<AgentControlIcon>(
    () =>
      function ChromeIcon(props: AgentControlIconProps) {
        return <ChromeSwitchIcon {...props} pending={pending} />;
      },
    [pending],
  );
  const accessibilityState = useMemo(
    () => ({ checked: enabled, disabled, busy: pending }),
    [disabled, enabled, pending],
  );
  if (!visible || !feature) return null;

  const tooltip = pending
    ? `Turning Chrome developer access ${pendingValue ? "on" : "off"}`
    : `${enabled ? "Disable" : "Enable"} Chrome developer access`;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <AgentControlTrigger
          icon={icon}
          iconColor={enabled ? styles.iconOn.color : styles.iconOff.color}
          surface="toolbar"
          label={feature.label}
          value={enabled ? "On" : "Off"}
          disabled={disabled}
          onPress={handlePress}
          accessibilityLabel={tooltip}
          accessibilityRole="switch"
          accessibilityState={accessibilityState}
          testID="thread-chrome-switch"
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconOn: {
    color: theme.colors.palette.green[400],
  },
  iconOff: {
    color: theme.colors.foregroundMuted,
  },
  pendingGlyph: {
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
