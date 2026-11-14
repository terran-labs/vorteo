import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-modal-sheet";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
  type ControlSize,
} from "@/components/ui/control-geometry";
import { useContainedControlSize } from "@/components/ui/control-size";
import { hoverStyle } from "@/styles/hover";
import { LiveAnnouncement } from "@/components/ui/visually-hidden";

const FIELD_CHROME = { sm: "chromeSm", md: "chromeMd" } as const satisfies Record<
  ControlSize,
  string
>;
const FIELD_TEXT = { sm: "inputSm", md: "inputMd" } as const satisfies Record<ControlSize, string>;

interface FieldProps {
  label: string;
  children: ReactNode;
  trailing?: ReactNode;
  hint?: string;
  error?: string | null;
  testID?: string;
}

/**
 * Ties a field's visible label, hint and error to the input inside it, so assistive technology
 * reads the same name the eye sees and hears the hint or error as its description.
 */
interface FieldAssociation {
  labelId: string;
  describedById: string | undefined;
  invalid: boolean;
}
const FieldContext = createContext<FieldAssociation | null>(null);

export function Field({ label, children, trailing, hint, error, testID }: FieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const subtextId = `${id}-subtext`;
  const hintTestID = useMemo(() => (testID ? `${testID}-hint` : undefined), [testID]);
  const errorTestID = useMemo(() => (testID ? `${testID}-error` : undefined), [testID]);
  const subtext = useMemo(() => {
    if (error) {
      // Errors wrap rather than truncate, so the whole message stays readable.
      return (
        <Text nativeID={subtextId} style={styles.errorText} testID={errorTestID}>
          {error}
        </Text>
      );
    }
    if (hint) {
      return (
        <Text nativeID={subtextId} style={styles.hintText} testID={hintTestID}>
          {hint}
        </Text>
      );
    }
    return null;
  }, [error, hint, errorTestID, hintTestID, subtextId]);
  const association = useMemo(
    () => ({
      labelId,
      describedById: error || hint ? subtextId : undefined,
      invalid: Boolean(error),
    }),
    [labelId, subtextId, error, hint],
  );

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.header}>
        <Text nativeID={labelId} style={styles.label}>
          {label}
        </Text>
        {trailing}
      </View>
      <FieldContext.Provider value={association}>{children}</FieldContext.Provider>
      {subtext}
      {/* Mounted with the field, so an error that appears later is announced. */}
      <LiveAnnouncement message={error ?? null} />
    </View>
  );
}

/**
 * ARIA props for an input inside a `Field`. The visible label names the input unless the caller
 * names it explicitly; the hint or error describes it. Inputs outside a Field get nothing.
 */
export function useFieldAssociation(explicit: {
  accessibilityLabel?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const field = useContext(FieldContext);
  if (!field) return {};
  const named =
    explicit.accessibilityLabel !== undefined ||
    explicit["aria-label"] !== undefined ||
    explicit["aria-labelledby"] !== undefined;
  return {
    ...(named ? {} : { "aria-labelledby": field.labelId }),
    ...(field.describedById && explicit["aria-describedby"] === undefined
      ? { "aria-describedby": field.describedById }
      : {}),
    ...(field.invalid && explicit["aria-invalid"] === undefined ? { "aria-invalid": true } : {}),
  };
}

type FormTextInputProps = AdaptiveTextInputProps & {
  size?: ControlSize;
};

type FlatFormTextInputStyle = ViewStyle & TextStyle;

interface SplitFormTextInputStyle {
  chromeStyle?: ViewStyle;
  inputStyle?: TextStyle;
}

function splitFormTextInputStyle(style: AdaptiveTextInputProps["style"]): SplitFormTextInputStyle {
  const flattened = RNStyleSheet.flatten(style) as FlatFormTextInputStyle | undefined;
  if (!flattened) {
    return {};
  }

  const {
    color,
    fontFamily,
    fontSize,
    fontStyle,
    fontVariant,
    fontWeight,
    includeFontPadding,
    letterSpacing,
    lineHeight,
    textAlign,
    textAlignVertical,
    textDecorationColor,
    textDecorationLine,
    textDecorationStyle,
    textShadowColor,
    textShadowOffset,
    textShadowRadius,
    textTransform,
    writingDirection,
    ...chromeStyle
  } = flattened;

  const inputStyle: TextStyle = {
    color,
    fontFamily,
    fontSize,
    fontStyle,
    fontVariant,
    fontWeight,
    includeFontPadding,
    letterSpacing,
    lineHeight,
    textAlign,
    textAlignVertical,
    textDecorationColor,
    textDecorationLine,
    textDecorationStyle,
    textShadowColor,
    textShadowOffset,
    textShadowRadius,
    textTransform,
    writingDirection,
  };

  return {
    chromeStyle: stripUnistylesMetadata(chromeStyle),
    inputStyle: stripUnistylesMetadata(inputStyle),
  };
}

function stripUnistylesMetadata<TStyle extends object>(style: TStyle): TStyle {
  const cleanStyle: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
    if (key.startsWith("unistyles_") || value === undefined) {
      continue;
    }
    cleanStyle[key] = value;
  }
  return cleanStyle as TStyle;
}

function assignTextInputRef(
  forwardedRef: ForwardedRef<EditingTextInputHandle>,
  node: EditingTextInputHandle | null,
): void {
  if (typeof forwardedRef === "function") {
    forwardedRef(node);
    return;
  }
  if (forwardedRef) {
    forwardedRef.current = node;
  }
}

export const FormTextInput = forwardRef<EditingTextInputHandle, FormTextInputProps>(
  function FormTextInput({ size: sizeProp, style, onFocus, onBlur, editable, ...props }, ref) {
    const [focused, setFocused] = useState(false);
    const association = useFieldAssociation(
      props as unknown as Parameters<typeof useFieldAssociation>[0],
    );
    const containedSize = useContainedControlSize();
    const size = sizeProp ?? containedSize ?? "md";
    const isDisabled = editable === false;
    const chromeSizeStyle = formInputStyles[FIELD_CHROME[size]];
    const inputSizeStyle = formInputStyles[FIELD_TEXT[size]];
    const splitStyle = useMemo(() => splitFormTextInputStyle(style), [style]);
    const setInputRef = useCallback(
      (node: EditingTextInputHandle | null) => {
        assignTextInputRef(ref, node);
      },
      [ref],
    );
    const handleFocus = useCallback<NonNullable<AdaptiveTextInputProps["onFocus"]>>(
      (event) => {
        setFocused(true);
        onFocus?.(event);
      },
      [onFocus],
    );
    const handleBlur = useCallback<NonNullable<AdaptiveTextInputProps["onBlur"]>>(
      (event) => {
        setFocused(false);
        onBlur?.(event);
      },
      [onBlur],
    );
    const inputStyle = useMemo(
      () => [formInputStyles.input, inputSizeStyle, splitStyle.inputStyle],
      [inputSizeStyle, splitStyle.inputStyle],
    ) as AdaptiveTextInputProps["style"];
    // Hover is CSS (`controlHoverable`), so the border clears as soon as the field moves away.
    const chromeStyle = useMemo(
      () => [
        formInputStyles.chrome,
        chromeSizeStyle,
        resolveControlInteractionStyles(
          {
            controlRest: formInputStyles.controlRest,
            controlHover: null,
            controlHoverable: formInputStyles.controlHoverable,
            controlActive: formInputStyles.controlActive,
            controlDisabled: formInputStyles.controlDisabled,
          },
          {
            focused,
            disabled: isDisabled,
          },
        ),
        splitStyle.chromeStyle,
      ],
      [chromeSizeStyle, focused, isDisabled, splitStyle.chromeStyle],
    );

    return (
      <Pressable disabled={isDisabled} style={chromeStyle}>
        <AdaptiveTextInput
          ref={setInputRef}
          editable={editable}
          {...association}
          {...props}
          onBlur={handleBlur}
          onFocus={handleFocus}
          style={inputStyle}
        />
      </Pressable>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
}));

const formInputStyles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    chrome: {
      backgroundColor: theme.colors.surface2,
    },
    chromeSm: {
      ...geometry.fieldControlSm,
    },
    chromeMd: {
      ...geometry.fieldControlMd,
    },
    // The fill alone is 1.04 to 1.24:1 against cards and dialogs, so a resting edge marks the
    // field at 3.94:1 or better in every theme; hover and focus strengthen it.
    controlRest: {
      ...geometry.controlRest,
      borderColor: theme.colors.foregroundExtraMuted,
    },
    controlHoverable: hoverStyle({ borderColor: theme.colors.foregroundMuted }),
    controlActive: {
      ...geometry.controlActive,
      borderColor: theme.colors.foregroundMuted,
    },
    controlDisabled: {
      ...geometry.controlDisabled,
    },
    input: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      paddingHorizontal: 0,
      paddingVertical: 0,
      outlineColor: "transparent",
      outlineWidth: 0,
    },
    inputSm: {
      ...geometry.fieldTextSm,
    },
    inputMd: {
      ...geometry.fieldTextMd,
    },
  };
});
