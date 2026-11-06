import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useContainedControlSize } from "@/components/ui/control-size";
import {
  default as React,
  useCallback,
  useMemo,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import type {
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  controlIconSize,
  createControlGeometry,
  type ControlSize,
} from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import { groupHoverStyle, hoverGroup, hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";

/** Hover is browser-owned CSS on this group, so it clears when the button moves away. */
const BUTTON_HOVER_GROUP = "button";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";

type LeftIcon =
  | ReactElement
  | ComponentType<{ color: string; size: number }>
  | ((color: string) => ReactElement)
  | null;

interface ButtonIconProps {
  loading: boolean;
  leftIcon?: LeftIcon;
  iconSize: number;
  iconColor: string;
}

function ButtonIcon({ loading, leftIcon, iconSize, iconColor }: ButtonIconProps) {
  if (loading) {
    return (
      <View>
        <LoadingSpinner size="small" color={iconColor} />
      </View>
    );
  }

  if (!leftIcon) return null;

  if (typeof leftIcon === "object" && "type" in leftIcon) {
    return <View>{leftIcon}</View>;
  }

  if (
    typeof leftIcon === "function" &&
    !leftIcon.prototype?.isReactComponent &&
    leftIcon.length > 0
  ) {
    return <View>{(leftIcon as (color: string) => ReactElement)(iconColor)}</View>;
  }

  const Icon = leftIcon as ComponentType<{ color: string; size: number }>;
  return (
    <View>
      <Icon color={iconColor} size={iconSize} />
    </View>
  );
}

const ThemedButtonIcon = withUnistyles(ButtonIcon);

const foregroundIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foreground });
const foregroundMutedIconMapping = (theme: Theme) => ({
  iconColor: theme.colors.foregroundMuted,
});
const accentForegroundIconMapping = (theme: Theme) => ({
  iconColor: theme.colors.accentForeground,
});
const destructiveForegroundIconMapping = (theme: Theme) => ({
  iconColor: theme.colors.destructiveForeground,
});
// A ghost icon strokes with the button's CSS color on web, so CSS hover recolors it.
const currentColorIconMapping = () => ({ iconColor: "currentColor" });

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    base: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: "transparent",
    },
    md: {
      ...geometry.buttonMd,
    },
    sm: {
      ...geometry.buttonSm,
    },
    iconOnlySm: geometry.buttonIconOnlySm,
    iconOnlyMd: geometry.buttonIconOnlyMd,
    default: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    secondary: {
      backgroundColor: theme.colors.surface3,
      borderColor: theme.colors.surface3,
    },
    outline: {
      backgroundColor: "transparent",
      borderColor: theme.colors.borderAccent,
    },
    ghost: {
      backgroundColor: "transparent",
      borderColor: "transparent",
      _web: { color: theme.colors.foregroundMuted },
    },
    destructive: {
      backgroundColor: theme.colors.destructive,
      borderColor: theme.colors.destructive,
    },
    group: hoverGroup(BUTTON_HOVER_GROUP),
    hoveredNeutral: hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
    hoveredGhost: hoverStyle({
      backgroundColor: theme.colors.interactionHighlight,
      color: theme.colors.foreground,
    }),
    hoveredPrimary: hoverStyle({
      backgroundColor: theme.colors.accentBright,
      borderColor: theme.colors.accentBright,
    }),
    hoveredSecondary: hoverStyle({
      backgroundColor: theme.colors.surface4,
      borderColor: theme.colors.surface4,
    }),
    hoveredDestructive: hoverStyle({
      borderColor: theme.colors.destructiveForeground,
    }),
    pressed: {
      opacity: 0.85,
    },
    disabled: {
      opacity: theme.opacity[50],
    },
    text: {
      color: theme.colors.foreground,
      ...geometry.buttonTextMd,
      fontWeight: theme.fontWeight.medium,
    },
    textSm: {
      ...geometry.buttonTextSm,
    },
    textDefault: {
      color: theme.colors.accentForeground,
    },
    textDestructive: {
      color: theme.colors.destructiveForeground,
    },
    textGhost: {
      color: theme.colors.foregroundMuted,
    },
    textGhostHoverable: groupHoverStyle(BUTTON_HOVER_GROUP, { color: theme.colors.foreground }),
  };
});

export function Button({
  children,
  variant = "secondary",
  size: sizeProp,
  leftIcon,
  trailing,
  style,
  textStyle,
  numberOfLines,
  disabled,
  loading = false,
  accessibilityRole,
  accessibilityState: accessibilityStateProp,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, "style"> & {
    ref?: React.Ref<View>;
    variant?: ButtonVariant;
    size?: ControlSize;
    leftIcon?: LeftIcon;
    trailing?: ReactNode;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
    numberOfLines?: number;
    loading?: boolean;
  }
>) {
  const containedSize = useContainedControlSize();
  const size = sizeProp ?? containedSize ?? "md";
  const isDisabled = disabled || loading;

  let variantStyle: ViewStyle;
  if (variant === "default") {
    variantStyle = styles.default;
  } else if (variant === "secondary") {
    variantStyle = styles.secondary;
  } else if (variant === "outline") {
    variantStyle = styles.outline;
  } else if (variant === "ghost") {
    variantStyle = styles.ghost;
  } else {
    variantStyle = styles.destructive;
  }

  const isIconOnly = children == null && leftIcon != null;
  const sizeStyle = size === "sm" ? styles.sm : styles.md;
  const iconOnlyStyle = size === "sm" ? styles.iconOnlySm : styles.iconOnlyMd;
  const isGhostHoverable = !isDisabled && variant === "ghost";
  let variantHoverStyle = styles.hoveredNeutral;
  if (variant === "default") variantHoverStyle = styles.hoveredPrimary;
  else if (variant === "secondary") variantHoverStyle = styles.hoveredSecondary;
  else if (variant === "destructive") variantHoverStyle = styles.hoveredDestructive;
  else if (variant === "ghost") variantHoverStyle = styles.hoveredGhost;

  // CSS :hover outranks the base class, so a disabled button leaves the hover rule out. A caller
  // `style` merges into the same class but cannot outrank the hover rule.
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
      styles.base,
      styles.group,
      sizeStyle,
      isIconOnly ? iconOnlyStyle : null,
      variantStyle,
      isDisabled ? null : variantHoverStyle,
      pressed ? styles.pressed : null,
      isDisabled ? styles.disabled : null,
      style,
    ],
    [sizeStyle, isIconOnly, iconOnlyStyle, variantStyle, isDisabled, style, variantHoverStyle],
  );

  const resolvedTextStyle = useMemo(
    () => [
      styles.text,
      size === "sm" ? styles.textSm : null,
      variant === "default" ? styles.textDefault : null,
      variant === "destructive" ? styles.textDestructive : null,
      variant === "ghost" ? styles.textGhost : null,
      textStyle,
      isGhostHoverable ? styles.textGhostHoverable : null,
    ],
    [size, variant, textStyle, isGhostHoverable],
  );

  const accessibilityState = useMemo(
    () => ({ ...accessibilityStateProp, disabled: isDisabled, busy: loading }),
    [accessibilityStateProp, isDisabled, loading],
  );

  function resolveIconMapping() {
    if (variant === "default") {
      return accentForegroundIconMapping;
    }
    if (variant === "destructive") {
      return destructiveForegroundIconMapping;
    }
    if (variant === "ghost") {
      return isWeb && !loading ? currentColorIconMapping : foregroundMutedIconMapping;
    }
    return foregroundIconMapping;
  }

  return (
    <Pressable
      {...props}
      accessibilityRole={accessibilityRole ?? "button"}
      accessibilityState={accessibilityState}
      disabled={isDisabled}
      style={pressableStyle}
    >
      <ThemedButtonIcon
        loading={loading}
        leftIcon={leftIcon}
        iconSize={controlIconSize[size]}
        uniProps={resolveIconMapping()}
      />
      {children != null ? (
        <Text numberOfLines={numberOfLines} style={resolvedTextStyle}>
          {children}
        </Text>
      ) : null}
      {trailing}
    </Pressable>
  );
}
