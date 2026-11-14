import { useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  createControlGeometry,
  controlIconSize,
  type ControlSize,
} from "@/components/ui/control-geometry";
import { useContainedControlSize } from "@/components/ui/control-size";
import { isWeb } from "@/constants/platform";
import { hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";

type SegmentedControlIconRenderer = (props: { color: string; size: number }) => ReactNode;

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  icon?: SegmentedControlIconRenderer;
  disabled?: boolean;
  testID?: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: ControlSize;
  hideLabels?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Names the choice for assistive technology, such as "Sign-in type". */
  accessibilityLabel?: string;
  /** The `nativeID` of visible text that explains the choice. */
  "aria-describedby"?: string;
}

interface SegmentIconProps {
  icon: SegmentedControlIconRenderer;
  iconSize: number;
  iconColor: string;
}

function SegmentIcon({ icon, iconSize, iconColor }: SegmentIconProps) {
  return <View style={styles.iconContainer}>{icon({ color: iconColor, size: iconSize })}</View>;
}

const ThemedSegmentIcon = withUnistyles(SegmentIcon);

const selectedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foreground });
const mutedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foregroundMuted });

export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size: sizeProp,
  hideLabels = false,
  style,
  testID,
  accessibilityLabel,
  "aria-describedby": describedBy,
}: SegmentedControlProps<T>) {
  const containedSize = useContainedControlSize();
  const size = sizeProp ?? containedSize ?? "md";
  const sizeStyles = {
    sm: { container: styles.containerSm, segment: styles.segmentSm, label: styles.labelSm },
    md: { container: styles.containerMd, segment: styles.segmentMd, label: styles.labelMd },
  }[size];
  const containerSizeStyle = sizeStyles.container;
  const segmentSizeStyle = sizeStyles.segment;
  const labelSizeStyle = sizeStyles.label;
  const iconSize = controlIconSize[size];

  const containerStyle = useMemo(
    () => [styles.container, containerSizeStyle, style],
    [containerSizeStyle, style],
  );

  const containerRef = useRef<View>(null);
  useRadioGroupKeys(containerRef, options, value, onValueChange);
  // One segment is reachable by Tab: the selected one, or the first enabled one without a choice.
  const tabStop =
    options.find((option) => option.value === value && !option.disabled)?.value ??
    options.find((option) => !option.disabled)?.value;

  return (
    <View
      ref={containerRef}
      style={containerStyle}
      testID={testID}
      role="radiogroup"
      accessibilityLabel={accessibilityLabel}
      aria-describedby={describedBy}
    >
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <SegmentItem
            key={option.value}
            option={option}
            isSelected={isSelected}
            isTabStop={option.value === tabStop}
            iconSize={iconSize}
            hideLabels={hideLabels}
            segmentSizeStyle={segmentSizeStyle}
            labelSizeStyle={labelSizeStyle}
            currentValue={value}
            onValueChange={onValueChange}
          />
        );
      })}
    </View>
  );
}

const KEY_STEPS: Record<string, number | "first" | "last" | "focused"> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
  // react-native-web activates a radio on Enter only; Space chooses the focused one.
  " ": "focused",
};

/**
 * Arrow keys, Home and End move the choice between enabled segments and wrap at the ends, and
 * Space chooses the focused one, as a radio group does. Keys with a modifier pass through to
 * app shortcuts. Web only; native screen readers move between radios by swiping.
 */
function useRadioGroupKeys<T extends string>(
  containerRef: RefObject<View | null>,
  options: SegmentedControlOption<T>[],
  value: T,
  onValueChange: (value: T) => void,
) {
  const live = useRef({ options, value, onValueChange });
  live.current = { options, value, onValueChange };
  useEffect(() => {
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!isWeb || !node?.addEventListener) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const step = KEY_STEPS[event.key];
      if (step === undefined) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      const current = live.current;
      const radios = [...node.querySelectorAll<HTMLElement>('[role="radio"]')];
      // Moves start from the focused segment, which is the selected one unless it is disabled.
      const focused = radios.indexOf(document.activeElement as HTMLElement);
      const from =
        current.options[focused] ?? current.options.find((o) => o.value === current.value);
      const next = nextOption(current.options, from, step);
      if (!next) return;
      if (next.value !== current.value) current.onValueChange(next.value);
      radios[current.options.indexOf(next)]?.focus();
    };
    node.addEventListener("keydown", handleKeyDown);
    return () => node.removeEventListener("keydown", handleKeyDown);
  }, [containerRef]);
}

function nextOption<T extends string>(
  options: SegmentedControlOption<T>[],
  from: SegmentedControlOption<T> | undefined,
  step: number | "first" | "last" | "focused",
): SegmentedControlOption<T> | undefined {
  const enabled = options.filter((option) => !option.disabled);
  if (enabled.length === 0) return undefined;
  if (step === "focused") return from && !from.disabled ? from : undefined;
  if (step === "first") return enabled[0];
  if (step === "last") return enabled[enabled.length - 1];
  // From a disabled or missing segment, step through the full order to the nearest enabled one.
  let start = step > 0 ? -1 : options.length;
  if (from) start = options.indexOf(from);
  for (let offset = 1; offset <= options.length; offset++) {
    const candidate = options[(start + step * offset + options.length * 2) % options.length];
    if (candidate && !candidate.disabled) return candidate;
  }
  return undefined;
}

function SegmentItem<T extends string>({
  option,
  isSelected,
  isTabStop,
  iconSize,
  hideLabels,
  segmentSizeStyle,
  labelSizeStyle,
  currentValue,
  onValueChange,
}: {
  option: SegmentedControlOption<T>;
  isSelected: boolean;
  isTabStop: boolean;
  iconSize: number;
  hideLabels: boolean;
  segmentSizeStyle: StyleProp<ViewStyle>;
  labelSizeStyle: StyleProp<TextStyle>;
  currentValue: T;
  onValueChange: (value: T) => void;
}) {
  const labelStyle = useMemo(
    () => [styles.label, labelSizeStyle, isSelected && styles.labelSelected],
    [labelSizeStyle, isSelected],
  );
  const handlePress = useCallback(() => {
    if (!option.disabled && option.value !== currentValue) {
      onValueChange(option.value);
    }
  }, [option.disabled, option.value, currentValue, onValueChange]);
  const pressableStyle = useCallback(
    // CSS :hover outranks the base class, so the hover rule steps aside while selected or pressed.
    ({ pressed }: PressableStateCallbackType) => [
      styles.segment,
      segmentSizeStyle,
      isSelected && styles.segmentSelected,
      !isSelected && !pressed && !option.disabled && styles.segmentHoverable,
      pressed && !isSelected && styles.segmentPressed,
      option.disabled && styles.segmentDisabled,
    ],
    [isSelected, option.disabled, segmentSizeStyle],
  );
  const accessibilityState = useMemo(
    () => ({ checked: isSelected, disabled: option.disabled }),
    [isSelected, option.disabled],
  );
  return (
    // A radio in the group's radiogroup; buttons cannot carry a selected state in ARIA.
    <Pressable
      role="radio"
      accessibilityState={accessibilityState}
      aria-checked={isSelected}
      aria-disabled={option.disabled}
      // Named even when the label is hidden behind an icon.
      accessibilityLabel={option.label}
      tabIndex={isTabStop ? 0 : -1}
      disabled={option.disabled}
      testID={option.testID}
      onPress={handlePress}
      style={pressableStyle}
    >
      {option.icon ? (
        <ThemedSegmentIcon
          icon={option.icon}
          iconSize={iconSize}
          uniProps={isSelected ? selectedIconMapping : mutedIconMapping}
        />
      ) : null}
      {hideLabels ? null : (
        <Text style={labelStyle} numberOfLines={1}>
          {option.label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "transparent",
      gap: theme.spacing[1],
    },
    containerSm: {
      ...geometry.segmentedContainerSm,
    },
    containerMd: {
      ...geometry.segmentedContainerMd,
    },
    segment: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      gap: theme.spacing[1],
      borderWidth: 1,
      borderColor: "transparent",
    },
    segmentSm: {
      ...geometry.segmentedSegmentSm,
    },
    segmentMd: {
      ...geometry.segmentedSegmentMd,
    },
    // The fill alone is about 1.1 to 1.3:1 against a card, so the selected segment also carries
    // an outline that clears 3:1 in every theme; the others reserve the same border.
    segmentSelected: {
      backgroundColor: theme.colors.surface3,
      borderColor: theme.colors.foregroundMuted,
    },
    segmentHoverable: hoverStyle({ backgroundColor: theme.colors.surface2 }),
    segmentPressed: {
      backgroundColor: theme.colors.surface3,
    },
    segmentDisabled: {
      opacity: theme.opacity[50],
    },
    iconContainer: {
      alignItems: "center",
      justifyContent: "center",
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontWeight: theme.fontWeight.normal,
    },
    labelSm: {
      ...geometry.segmentedLabelSm,
    },
    labelMd: {
      ...geometry.segmentedLabelMd,
    },
    labelSelected: {
      color: theme.colors.foreground,
    },
  };
});
