import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import type { AdaptiveTextInputProps } from "@/components/adaptive-modal-sheet";
import type { ControlSize } from "@/components/ui/control-geometry";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { toErrorMessage } from "@/utils/error-messages";
import type { Theme } from "@/styles/theme";

/** How long the Saved tick stays after a successful save. */
const SAVED_TICK_MS = 2000;

type PassThroughInputProps = Pick<
  AdaptiveTextInputProps,
  | "maxLength"
  | "autoCorrect"
  | "autoCapitalize"
  | "autoComplete"
  | "keyboardType"
  | "inputMode"
  | "textContentType"
>;

export interface AutoSaveFieldProps extends PassThroughInputProps {
  /** Accessible name of the input. */
  label: string;
  /** The stored value. Escape reverts to it; a later change from elsewhere replaces the draft. */
  value: string;
  /**
   * Persists a changed, valid draft. Resolve with the stored form of the value when the save
   * normalizes it, such as trimming; reject to show the error and keep the draft for correction.
   */
  onSave: (draft: string) => Promise<string | void>;
  /** Returns an error message for an invalid draft, which is then not saved. */
  validate?: (draft: string) => string | null;
  /** Whether a draft differs from the stored value. Defaults to comparing trimmed text. */
  isChanged?: (draft: string, value: string) => boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Defaults to the enclosing row's control size. */
  size?: ControlSize;
  testID?: string;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

const defaultIsChanged = (draft: string, value: string) => draft.trim() !== value.trim();

/**
 * A single-value text setting with no Save button. It saves on Enter and on blur when the draft
 * changed and is valid, shows a spinner while saving and a brief Saved tick after, and keeps a
 * failed draft with its error below for correction. Escape reverts to the stored value. Use it for
 * simple fields; when submitting has side effects or needs confirmation, use `JoinedField`.
 */
export function AutoSaveField({
  label,
  value,
  onSave,
  validate,
  isChanged = defaultIsChanged,
  placeholder,
  disabled = false,
  size,
  testID,
  ...inputProps
}: AutoSaveFieldProps) {
  const input = useRef<EditingTextInputHandle>(null);
  const draft = useRef(value);
  const saving = useRef(false);
  const [state, setState] = useState<SaveState>({ kind: "idle" });

  // A value saved elsewhere replaces an untouched draft.
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current === value) return;
    if (draft.current === lastValue.current) {
      draft.current = value;
      input.current?.replaceText(value);
    }
    lastValue.current = value;
  }, [value]);

  useEffect(() => {
    if (state.kind !== "saved") return;
    const timer = setTimeout(() => setState({ kind: "idle" }), SAVED_TICK_MS);
    return () => clearTimeout(timer);
  }, [state.kind]);

  const changeText = useCallback(
    (text: string) => {
      draft.current = text;
      if (state.kind === "error" || state.kind === "saved") setState({ kind: "idle" });
    },
    [state.kind],
  );

  // Enter followed by the blur it causes must save once, so a running save absorbs the second.
  const save = useCallback(async () => {
    if (saving.current || disabled) return;
    const next = draft.current;
    if (!isChanged(next, lastValue.current)) return;
    const invalid = validate?.(next) ?? null;
    if (invalid) {
      setState({ kind: "error", message: invalid });
      return;
    }
    saving.current = true;
    setState({ kind: "saving" });
    try {
      const stored = await onSave(next);
      // The field stays editable while saving; only show the stored form if nothing changed since.
      const saved = typeof stored === "string" ? stored : next.trim();
      if (draft.current === next && saved !== next) {
        draft.current = saved;
        input.current?.replaceText(saved);
      }
      lastValue.current = saved;
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", message: toErrorMessage(error) });
    } finally {
      saving.current = false;
    }
  }, [disabled, isChanged, onSave, validate]);
  const commit = useCallback(() => void save(), [save]);

  const revert = useCallback((event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (event.nativeEvent.key !== "Escape" || saving.current) return;
    draft.current = lastValue.current;
    input.current?.replaceText(lastValue.current);
    setState({ kind: "idle" });
  }, []);

  const busy = state.kind === "saving";
  const errorId = useId();
  // Ties the error to the field, which React Native's types do not describe.
  const errorProps = useMemo(
    () =>
      (state.kind === "error"
        ? { "aria-invalid": true, "aria-describedby": errorId }
        : {}) as object,
    [state.kind, errorId],
  );
  const accessibilityState = useMemo(
    () => ({ disabled: disabled || busy, busy }),
    [disabled, busy],
  );
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <FormTextInput
          ref={input}
          size={size}
          initialValue={value}
          onChangeText={changeText}
          onSubmitEditing={commit}
          onBlur={commit}
          onKeyPress={revert}
          // Keeps focus in the field after Enter, and a save in flight never disables the
          // focused input; the running save absorbs a second Enter or blur.
          blurOnSubmit={false}
          placeholder={placeholder}
          editable={!disabled}
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          aria-busy={busy}
          testID={testID}
          style={styles.input}
          {...errorProps}
          {...inputProps}
        />
        {/* A fixed slot keeps the field from shifting when the status appears. Both live regions
            stay mounted, so screen readers announce their first message. */}
        <View style={styles.status} accessibilityLiveRegion="polite" aria-live="polite">
          {busy ? (
            <>
              <ThemedSpinner size="small" uniProps={spinnerColor} />
              <Text style={styles.visuallyHidden}>Saving</Text>
            </>
          ) : null}
          {state.kind === "saved" ? (
            <View style={styles.saved} testID={testID ? `${testID}-saved` : undefined}>
              <ThemedCheck size={14} uniProps={checkColor} />
              <Text style={styles.savedText}>Saved</Text>
            </View>
          ) : null}
        </View>
      </View>
      <View accessibilityLiveRegion="polite" aria-live="polite">
        {/* Announced by the live region; an alert inside it would be read twice. */}
        {state.kind === "error" ? (
          <Text
            nativeID={errorId}
            style={styles.error}
            testID={testID ? `${testID}-error` : undefined}
          >
            {state.message}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const ThemedCheck = withUnistyles(Check);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const checkColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const styles = StyleSheet.create((theme) => ({
  visuallyHidden: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
  container: {
    gap: theme.spacing[1],
    minWidth: 220,
    maxWidth: "100%",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  status: {
    minWidth: 56,
    flexDirection: "row",
    alignItems: "center",
  },
  saved: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  savedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
