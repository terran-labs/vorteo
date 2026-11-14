import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { View } from "react-native";
import { Check, Copy } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, useFieldAssociation } from "@/components/ui/form-field";
import { LiveAnnouncement } from "@/components/ui/visually-hidden";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

const COPIED_RESET_MS = 2000;

/**
 * A labelled, read-only monospace value, such as a sign-in link or one-time code, in an inset
 * field with a copy button floating at its right edge. Long values scroll inside the field
 * instead of wrapping the surrounding layout. Follows the pairing link and the installation
 * password command, which pair the same inset with a copy action.
 */
export function CopyField({
  label,
  value,
  hint,
  spellOut = false,
  onCopyFailed,
  testID,
}: {
  label: string;
  value: string;
  /** A short muted line below the field, such as when a code expires. */
  hint?: string;
  /** Reads the value one character at a time, for codes a person types elsewhere. */
  spellOut?: boolean;
  /** Reports a clipboard failure; the value stays selectable for a manual copy. */
  onCopyFailed?: () => void;
  testID?: string;
}) {
  const input = useRef<EditingTextInputHandle>(null);
  const [copied, setCopied] = useState(false);
  // Counts copies so a repeated copy is announced again.
  const [copies, setCopies] = useState(0);
  // The editor is uncontrolled; push a changed value, such as a new attempt's link, into it.
  useEffect(() => input.current?.replaceText(value), [value]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(async () => {
    try {
      await copyToClipboard(value);
      setCopied(true);
      setCopies((count) => count + 1);
    } catch {
      onCopyFailed?.();
    }
  }, [value, onCopyFailed]);
  const spoken = spellOut ? `${label}: ${[...value].join(" ")}` : label;
  return (
    <Field label={label} hint={hint} testID={testID}>
      <CopyFieldBody
        input={input}
        value={value}
        spoken={spoken}
        label={label}
        copied={copied}
        onCopy={copy}
        testID={testID}
      />
      <LiveAnnouncement message={copies > 0 ? "Copied" : null} sequence={copies} />
    </Field>
  );
}

/** Inside the Field, so the hint describes the value through the field association. */
function CopyFieldBody({
  input,
  value,
  spoken,
  label,
  copied,
  onCopy,
  testID,
}: {
  input: RefObject<EditingTextInputHandle | null>;
  value: string;
  spoken: string;
  label: string;
  copied: boolean;
  onCopy: () => void;
  testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  const association = useFieldAssociation({ accessibilityLabel: spoken });
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  return (
    <View style={[styles.inset, focused && styles.insetFocused]}>
      <TextInput
        ref={input}
        {...association}
        onFocus={focus}
        onBlur={blur}
        style={styles.value}
        initialValue={value}
        readOnly
        selectTextOnFocus
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={spoken}
        testID={testID ? `${testID}-value` : undefined}
      />
      <View style={styles.copy}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={copied ? Check : Copy}
          onPress={onCopy}
          accessibilityLabel={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
          testID={testID ? `${testID}-copy` : undefined}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inset: {
    position: "relative",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    // The same 3:1 resting edge as form fields; focus strengthens it and adds the ring.
    borderColor: theme.colors.foregroundExtraMuted,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  insetFocused: {
    borderColor: theme.colors.foregroundMuted,
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 1,
    outlineColor: theme.colors.foreground,
  } as object,
  value: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    // Clears the floating copy button so the end of a scrolled value stays readable.
    paddingRight: theme.spacing[8] + theme.spacing[1],
    outlineStyle: "none",
  } as object,
  copy: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: theme.spacing[1],
    justifyContent: "center",
  },
}));
