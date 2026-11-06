import { useCallback, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowUpRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import { groupHoverStyle, hoverGroup } from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

export interface ExternalLinkProps {
  href: string;
  label?: string;
  children?: ReactNode;
  onError?: (error: unknown) => void;
  tooltip?: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * Inline "Docs ↗" affordance — muted text + arrow-top-right icon, opens the
 * URL via the platform's external opener. Wrap in a Tooltip when there's a
 * one-line hint worth surfacing on hover. A native tap opens the URL.
 */
export function ExternalLink({
  href,
  label,
  children,
  onError,
  tooltip,
  testID,
  accessibilityLabel,
}: ExternalLinkProps) {
  const handlePress = useCallback(() => {
    void openExternalUrl(href).catch(onError ?? console.error);
  }, [href, onError]);

  const trigger = (
    <Pressable
      onPress={handlePress}
      hitSlop={8}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      style={styles.group}
    >
      <ExternalLinkLabel>{children ?? label}</ExternalLinkLabel>
    </Pressable>
  );

  if (!tooltip) {
    return trigger;
  }

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" align="end" offset={6}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * CSS hover group that turns an {@link ExternalLinkLabel} foreground. A pressable that owns the
 * label, such as a settings row that opens a page, spreads `hoverGroup(EXTERNAL_LINK_HOVER_GROUP)`
 * into its style.
 */
export const EXTERNAL_LINK_HOVER_GROUP = "external-link";

/**
 * What an external link looks like: muted text and an outward arrow, both turning foreground while
 * the enclosing {@link EXTERNAL_LINK_HOVER_GROUP} is hovered.
 */
export function ExternalLinkLabel({ children }: { children?: ReactNode }) {
  return (
    <View style={styles.trigger}>
      {children ? <Text style={styles.label}>{children}</Text> : null}
      {/* On web the arrow strokes with the trigger's CSS color, so group hover recolors it. */}
      {isWeb ? (
        <ArrowUpRight size={12} color="currentColor" />
      ) : (
        <ThemedArrowUpRight size={12} uniProps={iconColor} />
      )}
    </View>
  );
}

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedArrowUpRight = withUnistyles(ArrowUpRight);

const styles = StyleSheet.create((theme) => ({
  group: hoverGroup(EXTERNAL_LINK_HOVER_GROUP),
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    ...groupHoverStyle(
      EXTERNAL_LINK_HOVER_GROUP,
      { color: theme.colors.foreground },
      { color: theme.colors.foregroundMuted },
    ),
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    ...groupHoverStyle(EXTERNAL_LINK_HOVER_GROUP, { color: theme.colors.foreground }),
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    maxWidth: 280,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
