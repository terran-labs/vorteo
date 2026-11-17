import { forwardRef, useCallback, useId, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AdaptiveTextInputProps } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { ControlSize } from "@/components/ui/control-geometry";
import { useContainedControlSize } from "@/components/ui/control-size";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

/** Text input props a joined field passes through, such as `maxLength` or `secureTextEntry`. */
type PassThroughInputProps = Pick<
  AdaptiveTextInputProps,
  | "maxLength"
  | "autoCorrect"
  | "autoCapitalize"
  | "autoComplete"
  | "secureTextEntry"
  | "keyboardType"
  | "inputMode"
  | "textContentType"
  | "resetKey"
>;

export interface JoinedFieldProps extends PassThroughInputProps {
  /** Accessible name of the input. Also prefixes the button's name, such as "Save installation name". */
  label: string;
  /** Seeds the input once. The field owns in-progress text; observe it with `onChangeText`. */
  initialValue?: string;
  onChangeText: (text: string) => void;
  /** Runs from the button and from Enter in the input. Ignored while disabled or busy. */
  onSubmit: () => void;
  /** Button text. Defaults to "Save". */
  submitLabel?: string;
  /** The button's accessible name when its text alone is unclear. Defaults to `submitLabel`. */
  submitAccessibilityLabel?: string;
  /** Blocks submitting, for example when nothing changed. The input stays editable. */
  submitDisabled?: boolean;
  /** Shows a spinner in the button and locks the input while the submit runs. */
  busy?: boolean;
  /** Locks both the input and the button. */
  disabled?: boolean;
  placeholder?: string;
  /** Shown below the control and announced as an alert. */
  error?: string | null;
  /** `default` when the submit is the surface's one primary action; `outline` otherwise. */
  submitVariant?: "default" | "outline";
  /** Defaults to the enclosing row's control size. */
  size?: ControlSize;
  /** The input's test ID. */
  testID?: string;
  /** The button's test ID. Defaults to `<testID>-submit`. */
  submitTestID?: string;
}

/**
 * One control made of a text input and its submit button on a single row. The two halves share a
 * border and meet with square corners, so they read as one control; the outer corners keep the
 * field radius. Use it for every inline "type a value, then Save" pair in settings instead of a
 * full-width input stacked over a full-width button.
 */
export const JoinedField = forwardRef<EditingTextInputHandle, JoinedFieldProps>(
  function JoinedField(
    {
      label,
      initialValue,
      onChangeText,
      onSubmit,
      submitLabel = "Save",
      submitAccessibilityLabel,
      submitDisabled = false,
      busy = false,
      disabled = false,
      placeholder,
      error,
      submitVariant = "outline",
      size: sizeProp,
      testID,
      submitTestID,
      ...inputProps
    },
    ref,
  ) {
    const containedSize = useContainedControlSize();
    const size = sizeProp ?? containedSize ?? "md";
    const blocked = disabled || busy || submitDisabled;
    const inputState = useMemo(() => ({ disabled, busy }), [disabled, busy]);
    const errorId = useId();
    // Ties the error to the field, which React Native's types do not describe.
    const errorProps = useMemo(
      () => (error ? { "aria-invalid": true, "aria-describedby": errorId } : {}) as object,
      [error, errorId],
    );
    const buttonState = useMemo(() => ({ disabled: blocked, busy }), [blocked, busy]);
    const submit = useCallback(() => {
      if (!blocked) onSubmit();
    }, [blocked, onSubmit]);
    const inputStyle = useMemo(
      () => [styles.input, size === "sm" ? styles.inputSm : styles.inputMd],
      [size],
    );
    const buttonStyle = useMemo(
      () => [
        styles.button,
        size === "sm" ? styles.buttonSm : styles.buttonMd,
        submitVariant === "outline" ? styles.buttonOutline : null,
      ],
      [size, submitVariant],
    );
    return (
      <View style={styles.container}>
        <View style={styles.row}>
          <FormTextInput
            ref={ref}
            size={size}
            initialValue={initialValue}
            onChangeText={onChangeText}
            onSubmitEditing={submit}
            // Focus stays in the field after Enter; a submit in flight blocks a second one
            // instead of disabling the focused input.
            blurOnSubmit={false}
            placeholder={placeholder}
            editable={!disabled}
            accessibilityLabel={label}
            accessibilityState={inputState}
            aria-busy={busy}
            testID={testID}
            style={inputStyle}
            {...errorProps}
            {...inputProps}
          />
          <Button
            variant={submitVariant}
            size={size}
            onPress={submit}
            disabled={disabled || submitDisabled}
            loading={busy}
            accessibilityLabel={submitAccessibilityLabel ?? submitLabel}
            accessibilityState={buttonState}
            aria-busy={busy}
            testID={submitTestID ?? (testID ? `${testID}-submit` : undefined)}
            style={buttonStyle}
          >
            {submitLabel}
          </Button>
        </View>
        {/* The live region stays mounted so its first message is announced. */}
        <View accessibilityLiveRegion="polite" aria-live="polite">
          {/* Announced by the live region; an alert inside it would be read twice. */}
          {error ? (
            <Text
              nativeID={errorId}
              style={styles.error}
              testID={testID ? `${testID}-error` : undefined}
            >
              {error}
            </Text>
          ) : null}
        </View>
      </View>
    );
  },
);

// The halves meet with square corners. The input drops its right border so the button's left
// border is the single seam between them, and an outline submit shares the input's accent border so
// the pair reads as one control. Outer corners match the field radius of each size.
const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
    minWidth: 220,
    maxWidth: "100%",
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    borderColor: theme.colors.borderAccent,
    borderRightWidth: 0,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  inputSm: {
    borderTopLeftRadius: theme.borderRadius.md,
    borderBottomLeftRadius: theme.borderRadius.md,
  },
  inputMd: {
    borderTopLeftRadius: theme.borderRadius.lg,
    borderBottomLeftRadius: theme.borderRadius.lg,
  },
  button: {
    flexShrink: 0,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
  },
  buttonOutline: {
    borderColor: theme.colors.borderAccent,
  },
  buttonSm: {
    borderTopRightRadius: theme.borderRadius.md,
    borderBottomRightRadius: theme.borderRadius.md,
  },
  buttonMd: {
    borderTopRightRadius: theme.borderRadius.lg,
    borderBottomRightRadius: theme.borderRadius.lg,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
