import { type ComponentProps } from "react";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";

/**
 * A row action on an account or connection. It uses the shared control sizes, so it matches
 * the switch and menu beside it: 32px where a pointer drives it and 44px in the compact layout.
 * Pass `variant="default"` for the one primary action in a row, such as Connect; everything
 * else stays outline so it reads as a button without competing with it.
 */
export function CompactAccountButton({
  style,
  textStyle,
  testID,
  tone = "default",
  dense = false,
  variant = "outline",
  ...props
}: ComponentProps<typeof Button> & {
  tone?: "default" | "danger";
  dense?: boolean;
}) {
  // Dense usage badges have always been outlined pills, whatever their caller passes.
  const resolvedVariant = dense ? "outline" : variant;
  // A filled primary button carries its own contrast, so the danger tone only tints outlines.
  const danger = tone === "danger" && resolvedVariant === "outline";
  return (
    <Button
      {...props}
      testID={testID}
      variant={resolvedVariant}
      size={dense ? "sm" : props.size}
      style={[
        // Dense badges keep their visual size on touch too; callers extend the hit area.
        dense && styles.denseTarget,
        danger && styles.dangerOutline,
        style,
      ]}
      textStyle={[danger && styles.dangerText, textStyle]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  dangerText: { color: theme.colors.destructive },
  dangerOutline: { borderColor: theme.colors.destructive },
  denseTarget: {
    height: CONTROL_HEIGHTS.sm,
    minHeight: CONTROL_HEIGHTS.sm,
    borderRadius: theme.borderRadius.md,
    paddingVertical: 0,
  },
}));
