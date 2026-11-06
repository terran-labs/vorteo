import { forwardRef, useCallback, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { groupHoverStyle, hoverGroup, hoverStyle } from "@/styles/hover";

/** Hover is browser-owned CSS on this group, so a trigger never keeps a stale highlight. */
const TRIGGER_HOVER_GROUP = "toolbar-label-trigger";

export type ToolbarLabelTriggerState = PressableStateCallbackType & {
  /** Accepted from Pressable state but ignored: hover is CSS. */
  hovered?: boolean;
  open?: boolean;
};

/** Pressed or open. Hover is drawn by CSS from {@link toolbarLabelTriggerStyle}. */
export function isToolbarLabelTriggerHighlighted(state: ToolbarLabelTriggerState): boolean {
  return state.pressed || Boolean(state.open);
}

export function toolbarLabelTriggerStyle(state: ToolbarLabelTriggerState): StyleProp<ViewStyle> {
  return [
    toolbarLabelTriggerFrameStyle(),
    styles.group,
    isToolbarLabelTriggerHighlighted(state) ? styles.highlighted : styles.hoverable,
  ];
}

/** Shared spacing for interactive triggers and visually aligned passive context. */
export function toolbarLabelTriggerFrameStyle(): StyleProp<ViewStyle> {
  return styles.trigger;
}

export function toolbarLabelTriggerTextStyle(highlighted: boolean): StyleProp<TextStyle> {
  return [styles.label, highlighted ? styles.labelHighlighted : null];
}

/** Fixed geometry for glyphs beside labels. Text yields space; icons never do. */
export function ToolbarLabelTriggerIcon({ children }: { children: ReactNode }) {
  return <View style={styles.icon}>{children}</View>;
}

interface ToolbarLabelSelectTriggerProps extends Omit<PressableProps, "children" | "style"> {
  label: string;
  open?: boolean;
}

const ThemedChevronDown = withUnistyles(ChevronDown);

/** The shared current/base branch geometry. Disabled keeps the frame but has no interaction. */
export const ToolbarLabelSelectTrigger = forwardRef<View, ToolbarLabelSelectTriggerProps>(
  function ToolbarLabelSelectTrigger({ label, open = false, ...props }, ref) {
    const triggerStyle = useCallback(
      (state: ToolbarLabelTriggerState) => toolbarLabelTriggerStyle({ ...state, open }),
      [open],
    );
    return (
      <Pressable {...props} ref={ref} style={triggerStyle}>
        {(state) => {
          const highlighted = isToolbarLabelTriggerHighlighted({ ...state, open });
          return (
            <>
              <Text style={toolbarLabelTriggerTextStyle(highlighted)} numberOfLines={1}>
                {label}
              </Text>
              <ToolbarLabelTriggerIcon>
                <ThemedChevronDown size={12} uniProps={extraMutedIconColorMapping} />
              </ToolbarLabelTriggerIcon>
            </>
          );
        }}
      </Pressable>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 1,
  },
  group: hoverGroup(TRIGGER_HOVER_GROUP),
  highlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  hoverable: hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
  label: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    ...groupHoverStyle(TRIGGER_HOVER_GROUP, { color: theme.colors.foreground }),
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  icon: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
}));
