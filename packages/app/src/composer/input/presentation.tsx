import { useCallback, type ReactNode, type Ref } from "react";
import { View, type ViewProps } from "react-native";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ComposerFullscreenBody, ComposerFullscreenFooter } from "@/composer/dock";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE } from "@/styles/theme";
import { StyleSheet } from "react-native-unistyles";
import { useComposerFullscreenExit } from "./fullscreen-exit";
import { CARD_GAP } from "@/agent-stream/columns/geometry";

const CONTROL_SIZE = 44;
const FULLSCREEN_GLYPH_SIZE = ICON_SIZE.md;

function keepEditorFocused(event: import("react-native").PointerEvent) {
  if (isWeb) event.preventDefault();
}

/**
 * One tree for both layout modes. The editing surface keeps its position so the
 * mounted editor, its native buffer, selection, and focus survive every toggle;
 * only the chrome changes. Fullscreen controls share a bottom row beneath the editor.
 */
export function ComposerInputPresentation({
  fullscreen,
  surface,
  toolbar,
  send,
  error,
  onExit,
  inputWrapperRef,
  inputWrapperStyle,
  inputPointerEvents,
  attachmentSlot,
  showFullscreenButton,
  onEnter,
  rail,
  overlay,
  fullscreenControls,
}: {
  fullscreen: boolean;
  surface: ReactNode;
  toolbar: ReactNode;
  send: ReactNode;
  error: ReactNode;
  onExit: () => void;
  inputWrapperRef: Ref<View>;
  inputWrapperStyle: ViewProps["style"];
  inputPointerEvents: ViewProps["pointerEvents"];
  attachmentSlot: ReactNode;
  showFullscreenButton: boolean;
  onEnter: () => void;
  /** Phone controls positioned against the surface itself, outside its padded rows. */
  rail?: ReactNode;
  overlay: ReactNode;
  fullscreenControls: ReactNode;
}) {
  const { t } = useTranslation();
  // A retained tab keeps its fullscreen editor mounted while hidden; the global exit
  // action (Escape, hardware back) belongs only to the pane the user is in.
  const { isActiveComposer } = useComposerKeyboardScope();
  const exitScopeRef = useComposerFullscreenExit(fullscreen && isActiveComposer, onExit);
  const maximizeIcon = useCallback(
    (color: string) => <Maximize2 color={color} size={FULLSCREEN_GLYPH_SIZE} />,
    [],
  );
  const minimizeIcon = useCallback(
    (color: string) => <Minimize2 color={color} size={FULLSCREEN_GLYPH_SIZE} />,
    [],
  );
  return (
    <View
      ref={exitScopeRef}
      style={fullscreen ? styles.fullscreen : styles.inline}
      testID={fullscreen ? "composer-fullscreen" : undefined}
    >
      <ComposerFullscreenBody fullscreen={fullscreen}>
        <View
          ref={inputWrapperRef}
          testID="message-input-surface"
          style={fullscreen ? styles.fullscreenInputWrapper : inputWrapperStyle}
          pointerEvents={inputPointerEvents}
        >
          {fullscreen ? null : attachmentSlot}
          <View style={fullscreen ? styles.fullscreenTextSurface : styles.inlineTextSurface}>
            {surface}
          </View>
          {fullscreen ? null : toolbar}
          {fullscreen ? null : rail}
          {showFullscreenButton && !fullscreen ? (
            <Button
              variant="outline"
              size="sm"
              accessibilityLabel={t("composer.input.fullscreen")}
              leftIcon={maximizeIcon}
              onPointerDown={keepEditorFocused}
              onPress={onEnter}
              style={styles.enterButton}
              hitSlop={8}
            >
              {null}
            </Button>
          ) : null}
        </View>
      </ComposerFullscreenBody>
      {fullscreen ? (
        <ComposerFullscreenFooter style={styles.footer}>
          {error}
          <View style={styles.sendRow}>
            <Button
              variant="outline"
              accessibilityLabel={t("composer.input.exitFullscreen")}
              onPointerDown={keepEditorFocused}
              onPress={onExit}
              style={styles.iconButton}
              leftIcon={minimizeIcon}
            >
              {null}
            </Button>
            {fullscreenControls}
            {send}
          </View>
        </ComposerFullscreenFooter>
      ) : null}
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inline: { flexShrink: 1, position: "relative" },
  inlineTextSurface: { flexShrink: 1, position: "relative" },
  iconButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    padding: 0,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.full,
  },
  enterButton: {
    position: "absolute",
    bottom: 6 + (CONTROL_SIZE + CARD_GAP) * 3,
    right: 6,
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    padding: 0,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.full,
  },
  fullscreen: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  fullscreenInputWrapper: { flex: 1, minHeight: 0 },
  fullscreenTextSurface: { flex: 1, minHeight: 0 },
  // The send error rides the keyboard with Send; below the body it would sit behind it.
  footer: { flexShrink: 0, gap: theme.spacing[3] },
  sendRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: CARD_GAP,
  },
}));
