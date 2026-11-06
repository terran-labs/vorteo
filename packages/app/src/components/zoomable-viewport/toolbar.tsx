import React from "react";
import { Pressable, View } from "react-native";
import { Scan, ZoomIn, ZoomOut } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { CAN_HOVER, hoverStyle, revealOnGroupHover } from "@/styles/hover";
import { useVortonTouch } from "@/vorton-touch";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import type { ZoomableViewportAction } from "./types";

interface ViewportToolbarProps {
  actions: ZoomableViewportAction[];
  maxScale: number;
  minScale: number;
  onReset: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  scale: number;
  visible: boolean;
}

interface ResolvedViewportAction extends ZoomableViewportAction {
  disabled: boolean;
}

export const ViewportToolbar = React.memo(function ViewportToolbar({
  actions,
  maxScale,
  minScale,
  onReset,
  onZoomIn,
  onZoomOut,
  scale,
  visible,
}: ViewportToolbarProps) {
  const { t } = useTranslation();
  const viewportActions: ResolvedViewportAction[] = [
    {
      icon: ZoomIn,
      label: t("message.diagram.zoomIn"),
      onPress: onZoomIn,
      disabled: scale >= maxScale,
    },
    {
      icon: ZoomOut,
      label: t("message.diagram.zoomOut"),
      onPress: onZoomOut,
      disabled: scale <= minScale,
    },
    {
      icon: Scan,
      label: t("message.diagram.resetZoom"),
      onPress: onReset,
      disabled: scale === 1,
    },
    ...actions.map((action) => ({ ...action, disabled: false })),
  ];

  return (
    <View style={styles.cluster} pointerEvents="box-none" testID="zoomable-viewport-toolbar">
      {viewportActions.map((action) => (
        <ViewportToolbarButton
          key={action.label}
          action={action}
          disabled={action.disabled}
          visible={visible}
        />
      ))}
    </View>
  );
});

function ViewportToolbarButton({
  action,
  disabled,
  visible,
}: {
  action: ZoomableViewportAction;
  disabled: boolean;
  visible: boolean;
}) {
  const Icon = action.icon;
  const isCompact = useVortonTouch();
  const iconSize = iconButtonChromeGlyphSize("small", isCompact);
  const buttonStyle = React.useCallback(
    ({ pressed }: { pressed: boolean }) =>
      iconButtonChromeStyle({
        size: "small",
        compact: isCompact,
        state: { pressed },
        disabled,
        style: [
          visible ? styles.button : styles.buttonReveal,
          disabled ? styles.iconTintDisabled : styles.iconTint,
          isCompact ? styles.touchButton : null,
        ],
      }),
    [disabled, isCompact, visible],
  );
  return (
    <Pressable
      accessibilityLabel={action.label}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={isCompact ? 6 : 4}
      onPress={action.onPress}
      style={buttonStyle}
      testID={action.testID}
    >
      {/* Web tints through the button's CSS `color`, which follows `:hover`. */}
      <Icon size={iconSize} color={isWeb ? "currentColor" : styles.icon.color} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  cluster: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 1,
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  touchButton: { width: 44, height: 44 },
  button: {
    backgroundColor: theme.colors.surface2,
    opacity: 1,
    pointerEvents: "auto",
  },
  // `visible` is false only on web without touch: shown while the viewport hover group is
  // hovered or focused (see index.web.tsx), and always shown on devices without hover.
  // The toolbar overlay is click-through, so shown buttons must opt back into pointer events.
  buttonReveal: {
    backgroundColor: theme.colors.surface2,
    ...(CAN_HOVER ? revealOnGroupHover("zoom-viewport") : { opacity: 1, pointerEvents: "auto" }),
  },
  iconTint: hoverStyle({ color: theme.colors.foreground }, { color: theme.colors.foregroundMuted }),
  // Disabled buttons never reported hover, so they keep the muted tint.
  iconTintDisabled: { _web: { color: theme.colors.foregroundMuted } },
  icon: { color: theme.colors.foregroundMuted },
}));
