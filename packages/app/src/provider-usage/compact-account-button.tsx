import { type ComponentProps } from "react";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";

export function CompactAccountButton({
  style,
  textStyle,
  testID,
  tone = "default",
  dense = false,
  ...props
}: ComponentProps<typeof Button> & {
  tone?: "default" | "danger";
  dense?: boolean;
}) {
  return (
    <Button
      {...props}
      testID={testID}
      variant="outline"
      size="sm"
      style={[
        styles.target,
        // Dense badges keep their visual size on touch too; callers extend the hit area.
        dense && styles.denseTarget,
        tone === "danger" && styles.dangerOutline,
        style,
      ]}
      textStyle={[tone === "danger" && styles.dangerText, textStyle]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  dangerText: { color: theme.colors.destructive },
  dangerOutline: { borderColor: theme.colors.destructive },
  // Paint the border on the control itself so touch sizing cannot separate it from its label.
  target: {
    height: CONTROL_HEIGHTS.md.xs,
    minHeight: CONTROL_HEIGHTS.md.xs,
    minWidth: CONTROL_HEIGHTS.md.xs,
    borderWidth: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
    gap: theme.spacing[2],
  },
  denseTarget: {
    height: CONTROL_HEIGHTS.sm,
    minHeight: CONTROL_HEIGHTS.sm,
    borderRadius: theme.borderRadius.md,
    paddingVertical: 0,
  },
}));
