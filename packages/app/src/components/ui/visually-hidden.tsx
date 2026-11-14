import { useEffect, useId, useState, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

/**
 * Text for assistive technology only: kept in the accessibility tree, drawn nowhere, and
 * positioned absolutely so it never takes part in its parent's layout or gaps.
 */
export function VisuallyHiddenText({
  nativeID,
  live,
  children,
}: {
  nativeID?: string;
  /** Announces changes to the text. The region must mount before its first message. */
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <Text
      nativeID={nativeID}
      style={styles.hidden}
      {...(live
        ? { accessibilityLiveRegion: "polite" as const, "aria-live": "polite" as const }
        : {})}
    >
      {children}
    </Text>
  );
}

/**
 * react-native-web drops `accessibilityHint`. On web this renders the hint as hidden text and
 * returns the `aria-describedby` that points at it; on native the hint stays a hint. Render
 * `node` beside the control, never inside it, or the hint joins the control's name.
 */
export function useHiddenDescription(hint: string | undefined): {
  props: { accessibilityHint?: string; "aria-describedby"?: string };
  node: ReactNode;
} {
  const id = `${useId()}-description`;
  if (!hint) return { props: {}, node: null };
  if (!isWeb) return { props: { accessibilityHint: hint }, node: null };
  return {
    props: { "aria-describedby": id },
    node: <VisuallyHiddenText nativeID={id}>{hint}</VisuallyHiddenText>,
  };
}

/**
 * A polite announcement that is always mounted, so its first message is heard. Repeating the
 * same message clears the region for a frame first, so a repeat is announced too; pass a new
 * `sequence` to request that.
 */
export function LiveAnnouncement({
  message,
  sequence = 0,
}: {
  message: string | null;
  sequence?: number;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText("");
    if (!message) return;
    const frame = requestAnimationFrame(() => setText(message));
    return () => cancelAnimationFrame(frame);
  }, [message, sequence]);
  return <VisuallyHiddenText live>{text}</VisuallyHiddenText>;
}

const styles = StyleSheet.create({
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    borderWidth: 0,
    _web: { clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap" },
  },
});
