import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { getAgentFeatureIcon } from "@/agent-controls/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { getFeatureTooltip } from "@/composer/agent-controls/utils";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";

export const THREAD_CHROME_FEATURE_ID = "chrome";

/** The thread's Chrome toggle, when its provider offers one on this machine. */
export function findThreadChromeFeature(
  features: AgentFeature[] | undefined,
): Extract<AgentFeature, { type: "toggle" }> | null {
  const feature = features?.find((entry) => entry.id === THREAD_CHROME_FEATURE_ID);
  return feature?.type === "toggle" ? feature : null;
}

/**
 * Profile-based composers replace the per-thread controls that normally list provider
 * features, so Chrome gets its own switch beside the profile picker. It changes only this
 * thread and never saves Chrome as a provider default: the owner opts in each thread.
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
  const handlePress = useCallback(() => {
    void setFeature(THREAD_CHROME_FEATURE_ID, !enabled)?.catch((error: unknown) => {
      console.warn("[ThreadChromeSwitch] setAgentFeature failed", error);
      toast.error(toErrorMessage(error));
    });
  }, [enabled, setFeature, toast]);
  const accessibilityState = useMemo(() => ({ checked: enabled, disabled }), [disabled, enabled]);
  if (!visible || !feature) return null;

  const tooltip = `${getFeatureTooltip(feature)}: ${enabled ? "on" : "off"}`;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <AgentControlTrigger
          icon={getAgentFeatureIcon(feature.icon)}
          iconColor={enabled ? styles.iconOn.color : styles.iconOff.color}
          surface="toolbar"
          label={feature.label}
          value={enabled ? `${feature.label} on` : feature.label}
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
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
