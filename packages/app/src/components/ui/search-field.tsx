import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  Pressable,
  Text,
  View,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
  type LayoutChangeEvent,
} from "react-native";
import { Search, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";

const ThemedSearch = withUnistyles(Search);
const ThemedX = withUnistyles(X);
const ThemedTextInput = withUnistyles(TextInput, (theme: Theme) => ({
  // Placeholders sit at foregroundMuted and no dimmer — see docs/design.md §14.
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface SearchFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  /** Falls back to `placeholder`, which already names the field. */
  accessibilityLabel?: string;
  clearAccessibilityLabel: string;
  testID?: string;
  clearTestID?: string;
  /** Arrow and Escape handling for a result list the field drives. */
  onKeyPress?: TextInputProps["onKeyPress"];
  onSubmitEditing?: TextInputProps["onSubmitEditing"];
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Size the field to its placeholder and icon instead of filling the row. */
  fitPlaceholder?: boolean;
}

/**
 * The standalone search box that leads a screen's filter rail. Its chrome is
 * the host filter pill's, so the two sit on the same rail and read as one row
 * of controls; only the border colour moves on focus, which keeps the leading
 * icon from shifting. It owns its own clear affordance — a caller rendering its
 * own X has been handed the wrong component.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  clearAccessibilityLabel,
  testID,
  clearTestID,
  onKeyPress,
  onSubmitEditing,
  autoFocus,
  style,
  fitPlaceholder = false,
}: SearchFieldProps): ReactElement {
  const [isFocused, setIsFocused] = useState(false);
  const [placeholderWidth, setPlaceholderWidth] = useState(0);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const measurePlaceholder = useCallback((event: LayoutChangeEvent) => {
    setPlaceholderWidth(event.nativeEvent.layout.width);
  }, []);
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => setIsFocused(false), []);
  // The input is uncontrolled; follow a value the caller resets, such as
  // clearing the query after jumping to a result.
  useEffect(() => {
    const input = inputRef.current;
    if (input && input.getText() !== value) input.replaceText(value);
  }, [value]);
  const handleClear = useCallback(() => {
    inputRef.current?.replaceText("");
    onChangeText("");
  }, [onChangeText]);

  return (
    <View
      style={[
        styles.field,
        fitPlaceholder && styles.fitted(placeholderWidth),
        isFocused && styles.fieldFocused,
        style,
      ]}
    >
      {fitPlaceholder ? (
        <Text
          accessible={false}
          aria-hidden
          pointerEvents="none"
          numberOfLines={1}
          style={styles.placeholderMeasure}
          onLayout={measurePlaceholder}
        >
          {placeholder}
        </Text>
      ) : null}
      <ThemedSearch size={14} uniProps={mutedColorMapping} />
      <ThemedTextInput
        testID={testID}
        ref={inputRef}
        initialValue={value}
        onChangeText={onChangeText}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        accessibilityLabel={accessibilityLabel ?? placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onKeyPress={onKeyPress}
        onSubmitEditing={onSubmitEditing}
        autoFocus={autoFocus}
        style={styles.input}
      />
      {value.length > 0 ? (
        <Pressable
          testID={clearTestID}
          onPress={handleClear}
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel}
          hitSlop={8}
        >
          <ThemedX size={14} uniProps={mutedColorMapping} />
        </Pressable>
      ) : null}
    </View>
  );
}

const SEARCH_FIELD_MAX_WIDTH = 420;

const styles = StyleSheet.create((theme) => ({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
    maxWidth: SEARCH_FIELD_MAX_WIDTH,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  fitted: (placeholderWidth: number) => ({
    flexBasis: "auto",
    flexGrow: 0,
    flexShrink: 1,
    width:
      placeholderWidth > 0
        ? Math.ceil(placeholderWidth) +
          14 +
          theme.spacing[2] +
          theme.spacing[3] * 2 +
          theme.borderWidth[1] * 2
        : 164,
  }),
  placeholderMeasure: {
    position: "absolute",
    opacity: 0,
    fontSize: theme.fontSize.base,
  },
  fieldFocused: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 20,
    // The browser's focus ring would sit inside the field's own focus border.
    // `outlineWidth` is typed on ViewStyle since RN 0.81 and is a no-op on
    // native, so this needs neither a cast nor a platform branch.
    outlineWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
