import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ariaFromAccessibilityState } from "./accessibility-state";
import { useHiddenDescription } from "./visually-hidden";
import { useContainedControlSize } from "@/components/ui/control-size";
import {
  default as React,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
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
    // The button already reports busy; the spinner adds no words to its name.
    return (
      <View aria-hidden importantForAccessibility="no-hide-descendants">
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
    // The fill is 1.07 to 1.30:1 against a card, so the edge carries the button's boundary at
    // 3.94:1 or better in every theme.
    secondary: {
      backgroundColor: theme.colors.surface3,
      borderColor: theme.colors.foregroundExtraMuted,
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
      borderColor: theme.colors.foregroundMuted,
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

function variantStyles(variant: ButtonVariant): {
  variantStyle: ViewStyle;
  variantHoverStyle: ViewStyle;
} {
  if (variant === "default")
    return { variantStyle: styles.default, variantHoverStyle: styles.hoveredPrimary };
  if (variant === "secondary")
    return { variantStyle: styles.secondary, variantHoverStyle: styles.hoveredSecondary };
  if (variant === "outline")
    return { variantStyle: styles.outline, variantHoverStyle: styles.hoveredNeutral };
  if (variant === "ghost")
    return { variantStyle: styles.ghost, variantHoverStyle: styles.hoveredGhost };
  return { variantStyle: styles.destructive, variantHoverStyle: styles.hoveredDestructive };
}

type PressHandlers = Pick<PressableProps, "onPress" | "onPressIn" | "onPressOut" | "onLongPress">;

/** A disabled or loading button ignores presses but, while loading, keeps its focus. */
function pressHandlers(inert: boolean, handlers: PressHandlers): PressHandlers {
  return inert ? {} : handlers;
}

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
  focusableWhenDisabled = false,
  accessibilityRole,
  accessibilityState: accessibilityStateProp,
  accessibilityHint,
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  ref: forwardedRef,
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
    /**
     * Keeps a disabled button in the focus order, reporting `aria-disabled` and ignoring presses.
     * For controls that become unavailable while focused, such as a submit button during its
     * request, so keyboard focus is not dropped to the page.
     */
    focusableWhenDisabled?: boolean;
  }
>) {
  const containedSize = useContainedControlSize();
  const size = sizeProp ?? containedSize ?? "md";
  // Looks and reads disabled while loading, but stays focusable: a native `disabled` attribute
  // would blur the focused button and drop keyboard focus to the page.
  const isDisabled = disabled || loading;
  const description = useHiddenDescription(accessibilityHint ?? undefined);

  const { variantStyle, variantHoverStyle } = variantStyles(variant);

  const isIconOnly = children == null && leftIcon != null;
  const sizeStyle = size === "sm" ? styles.sm : styles.md;
  const iconOnlyStyle = size === "sm" ? styles.iconOnlySm : styles.iconOnlyMd;
  const isGhostHoverable = !isDisabled && variant === "ghost";

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
  const role = accessibilityRole ?? "button";
  // Web drops accessibilityState, so busy, pressed, expanded and selected also travel as ARIA.
  // Busy is announced only while loading, so idle buttons carry no aria-busy noise.
  const aria = useMemo(
    () =>
      ariaFromAccessibilityState(
        { ...accessibilityStateProp, ...(loading ? { busy: true } : {}) },
        role,
      ),
    [accessibilityStateProp, loading, role],
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

  const nativeDisabled = Boolean(disabled) && !focusableWhenDisabled;
  // react-native-web's Pressable writes `aria-disabled` from its own `disabled` prop after
  // spreading ours, so a loading or focusable-disabled button would read as enabled. Its
  // `disabled` prop cannot carry the state either: that sets the native attribute and drops
  // focus. Set the attribute on the element instead.
  const nodeRef = useRef<View | null>(null);
  const setRef = useCallback(
    (node: View | null) => {
      nodeRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  useLayoutEffect(() => {
    if (!isWeb) return;
    const element = nodeRef.current as unknown as HTMLElement | null;
    if (!element?.setAttribute) return;
    if (isDisabled) element.setAttribute("aria-disabled", "true");
    else element.removeAttribute("aria-disabled");
  }, [isDisabled, nativeDisabled]);

  const presses = pressHandlers(Boolean(disabled) || loading, {
    onPress,
    onPressIn,
    onPressOut,
    onLongPress,
  });
  const button = (
    <Pressable
      {...aria}
      {...description.props}
      {...props}
      accessibilityRole={role}
      accessibilityState={accessibilityState}
      ref={setRef}
      disabled={nativeDisabled}
      {...presses}
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
  if (!description.node) return button;
  return (
    <>
      {button}
      {description.node}
    </>
  );
}
