import type { ReactElement } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { composerPillStyles } from "@/composer/pill-styles";
import { ComposerTrackMark } from "@/composer/tracks";
import { isWeb } from "@/constants/platform";
import { groupHoverStyle, hoverGroup, hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import { useParentAgent } from "./use-parent-agent";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// On web the chevron inherits the pill's CSS color, so browser-owned hover can brighten it.
const inheritedIconColorMapping = isWeb ? () => ({ color: "currentColor" }) : mutedColorMapping;

/**
 * The way back from a subagent to the agent that started it. It leads the pill rail and names
 * the parent rather than saying "parent": in a stack of subagents the title is what tells you
 * where you will land.
 */
export function ParentAgentPill({
  serverId,
  parentAgentId,
}: {
  serverId: string;
  parentAgentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const parent = useParentAgent(serverId, parentAgentId);
  const label = parent.label ?? t("subagents.parent.backToParent");

  return (
    <PressHighlight
      testID="composer-parent-agent-pill"
      accessibilityRole="button"
      accessibilityLabel={t("subagents.parent.backTo", { label })}
      onPress={parent.open}
      style={[composerPillStyles.body, styles.body]}
      highlightStyle={composerPillStyles.bodyActive}
    >
      <ThemedChevronLeft size={14} uniProps={inheritedIconColorMapping} />
      <ComposerTrackMark bucket={parent.statusBucket} />
      <Text style={[composerPillStyles.label, styles.label]} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The chevron's box is wider than its stroke, so the pill pulls it toward the edge to keep the
  // visible glyph on the same inset as other pills' leading marks.
  body: {
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    // Browser-owned hover matching `composerPillStyles.bodyActive`; `color` tints the chevron.
    ...hoverGroup(
      "parent-pill",
      hoverStyle(
        { backgroundColor: theme.colors.surface2, color: theme.colors.foreground },
        { color: theme.colors.foregroundMuted },
      )._web,
    ),
  },
  label: {
    flexShrink: 1,
    maxWidth: { xs: 140, md: 240 },
    ...groupHoverStyle("parent-pill", { color: theme.colors.foreground }),
  },
}));
