import { CARD_GAP } from "@/agent-stream/columns/geometry";
import { useMobileComposerLayout } from "@/composer/mobile-layout";
import { EdgeFade } from "@/components/ui/edge-fade";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, Keyboard } from "react-native";
import {
  getInterfaceWindow,
  interfaceRect,
  useWindowDimensions,
} from "@/appearance/interface-geometry";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw, Check, Mic, Pencil, ListPlus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { VolumeMeter } from "./volume-meter";
import { isWeb } from "@/constants/platform";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { DictationStatus } from "@/hooks/use-dictation";
import { useVortonTouch } from "@/vorton-touch";
import { toErrorMessage } from "@/utils/error-messages";

interface DictationControlsProps {
  volume: number;
  duration: number;
  transcript?: string;
  isRecording: boolean;
  isProcessing: boolean;
  status: DictationStatus;
  onStart: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onAcceptAndSend: () => void;
  onAcceptAndQueue?: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  disabled?: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function DictationControls({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  onStart,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  disabled = false,
}: DictationControlsProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const micButtonStyle = useMemo(
    () => [styles.micButton, disabled && styles.buttonDisabled],
    [disabled],
  );
  const timerTextStyle = useMemo(
    () => [styles.timerText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const cancelButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.actionButtonCancel,
      actionsDisabled && !isFailed ? styles.buttonDisabled : undefined,
    ],
    [actionsDisabled, isFailed],
  );

  if (!showActiveState) {
    return (
      <Pressable
        onPress={onStart}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.start")}
        style={micButtonStyle}
      >
        <Mic size={theme.iconSize.md} color={theme.colors.foreground} />
      </Pressable>
    );
  }

  return (
    <View style={styles.activeContainer}>
      <View style={styles.meterWrapper}>
        <VolumeMeter volume={volume} isMuted={false} isSpeaking={false} orientation="horizontal" />
      </View>
      <Text style={timerTextStyle}>
        {status === "paused" ? t("message.dictation.paused") : formatDuration(duration)}
      </Text>
      <View style={styles.actionGroup}>
        <Pressable
          onPress={handleCancel}
          disabled={actionsDisabled && !isFailed}
          accessibilityLabel={t("message.dictation.cancel")}
          style={cancelButtonStyle}
        >
          <X size={theme.iconSize.sm} color={theme.colors.foreground} />
        </Pressable>
        {actionsDisabled ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="small" color={theme.colors.foreground} prominent />
          </View>
        ) : null}
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityLabel={t("message.dictation.retry")}
            style={[styles.actionButton, styles.actionButtonConfirm]}
          >
            <RefreshCcw size={theme.iconSize.sm} color={theme.colors.surface0} />
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityLabel={t("message.dictation.insert")}
              style={[styles.actionButton, styles.actionButtonSecondary]}
            >
              <Check size={theme.iconSize.sm} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityLabel={t("message.dictation.insertAndSend")}
              style={[styles.actionButton, styles.actionButtonConfirm]}
            >
              <ArrowUp size={theme.iconSize.sm} color={theme.colors.surface0} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Full-width overlay variant for the agent input footer.
 * Uses blue background with white icons.
 */
interface WindowEdges {
  left: number;
  right: number;
  bottom: number;
}

// Used until the panel has measured itself: the composer's 8px field inset plus its 8px margin.
const FALLBACK_WINDOW_EDGES: WindowEdges = { left: 16, right: 16, bottom: 16 };

/**
 * Distances from the panel to the window's left, right and bottom edges, so the phone recording
 * background can run full-bleed, including the bottom safe area, whatever insets the composer's
 * ancestors add. Measured in layout units, which exclude interface zoom.
 */
function useWindowEdges(enabled: boolean) {
  const ref = useRef<View>(null);
  const [edges, setEdges] = useState<WindowEdges>(FALLBACK_WINDOW_EDGES);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const measure = useCallback(() => {
    if (!enabled) {
      return;
    }
    ref.current?.measureInWindow((x, y, width, height) => {
      if (width === 0 && height === 0) {
        return;
      }
      const rect = interfaceRect({ x, y, width, height });
      const window = getInterfaceWindow();
      const next = {
        left: Math.max(0, rect.x),
        right: Math.max(0, window.width - rect.x - rect.width),
        bottom: Math.max(0, window.height - rect.y - rect.height),
      };
      setEdges((previous) =>
        previous.left === next.left &&
        previous.right === next.right &&
        previous.bottom === next.bottom
          ? previous
          : next,
      );
    });
  }, [enabled]);
  // Window size changes move the panel without resizing it, so onLayout alone would miss them.
  useLayoutEffect(measure, [measure, windowWidth, windowHeight]);
  useEffect(() => {
    if (!enabled) return;
    // Ancestor keyboard translations move the panel without triggering its onLayout.
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const viewport = isWeb ? window.visualViewport : null;
    viewport?.addEventListener("resize", refresh);
    viewport?.addEventListener("scroll", refresh);
    const shown = Keyboard.addListener("keyboardDidShow", refresh);
    const hidden = Keyboard.addListener("keyboardDidHide", refresh);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", refresh);
      viewport?.removeEventListener("scroll", refresh);
      shown.remove();
      hidden.remove();
    };
  }, [enabled, measure]);
  return { ref, edges, onLayout: measure };
}

export function DictationOverlay({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  errorText,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onAcceptAndQueue,
  onRetry,
  onDiscard,
}: Omit<DictationControlsProps, "onStart" | "disabled" | "transcript"> & { errorText?: string }) {
  const { theme } = useUnistyles();
  const touch = useVortonTouch();
  const mobileComposer = useMobileComposerLayout();
  const windowEdges = useWindowEdges(mobileComposer.enabled);
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const containerStyle = useMemo(
    () => [
      overlayStyles.container,
      touch && overlayStyles.touchContainer,
      { backgroundColor: theme.colors.accent },
      mobileComposer.enabled && overlayStyles.mobileContainer,
    ],
    [theme.colors.accent, touch, mobileComposer.enabled],
  );
  const overlayCancelButtonStyle = useMemo(
    () => [
      overlayStyles.cancelButton,
      touch && overlayStyles.touchCancel,
      mobileComposer.enabled && { bottom: mobileComposer.bottomPadding + 1 },
      actionsDisabled && !isFailed && overlayStyles.buttonDisabled,
    ],
    [actionsDisabled, isFailed, touch, mobileComposer.enabled, mobileComposer.bottomPadding],
  );
  const overlayTimerTextStyle = useMemo(
    () => [overlayStyles.timerText, { color: theme.colors.accentForeground }],
    [theme.colors.accentForeground],
  );
  const overlayTranscriptTextStyle = useMemo(
    () => [overlayStyles.transcriptText, { color: theme.colors.accentForeground, opacity: 0.95 }],
    [theme.colors.accentForeground],
  );
  const overlayRetryButtonStyle = useMemo(
    () => [
      overlayStyles.actionButton,
      touch && overlayStyles.touchSubmit,
      mobileComposer.enabled && { bottom: mobileComposer.bottomPadding + 1 },
      { backgroundColor: theme.colors.accentForeground },
    ],
    [theme.colors.accentForeground, touch, mobileComposer.enabled, mobileComposer.bottomPadding],
  );
  const overlayConfirmButtonStyle = overlayRetryButtonStyle;
  const overlayEditButtonStyle = useMemo(
    () => [
      overlayStyles.actionButton,
      OVERLAY_ACCEPT_BUTTON_BG,
      touch && overlayStyles.touchEdit,
      touch && { bottom: 7 + (OVERLAY_BUTTON_SIZE + CARD_GAP) * (onAcceptAndQueue ? 2 : 1) },
    ],
    [touch, onAcceptAndQueue],
  );
  const mobileBackgroundStyle = useMemo(
    () => [
      overlayStyles.mobileBackground,
      {
        left: -windowEdges.edges.left,
        right: -windowEdges.edges.right,
        bottom: -windowEdges.edges.bottom,
        backgroundColor: theme.colors.accent,
      },
    ],
    [windowEdges.edges, theme.colors.accent],
  );
  const mobileFadeStyle = useMemo(
    () => [
      overlayStyles.mobileFade,
      { left: -windowEdges.edges.left, right: -windowEdges.edges.right },
    ],
    [windowEdges.edges],
  );
  const overlayLoadingStyle = useMemo(
    () => [
      overlayStyles.loadingContainer,
      touch && overlayStyles.touchSubmit,
      mobileComposer.enabled && { bottom: mobileComposer.bottomPadding + 1 },
    ],
    [touch, mobileComposer.enabled, mobileComposer.bottomPadding],
  );

  const queueButton = useMemo(
    () =>
      onAcceptAndQueue ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Queue recorded message"
          disabled={actionsDisabled || isFailed}
          onPress={onAcceptAndQueue}
          style={[
            overlayStyles.actionButton,
            OVERLAY_ACCEPT_BUTTON_BG,
            touch && overlayStyles.touchSubmit,
            touch && { bottom: 7 + OVERLAY_BUTTON_SIZE + CARD_GAP },
            actionsDisabled && overlayStyles.buttonDisabled,
          ]}
        >
          <ListPlus size={theme.iconSize.lg} color={theme.colors.accentForeground} />
        </Pressable>
      ) : null,
    [
      touch,
      onAcceptAndQueue,
      actionsDisabled,
      isFailed,
      theme.colors.accentForeground,
      theme.iconSize.lg,
    ],
  );

  if (!showActiveState) {
    return null;
  }

  return (
    <View
      ref={windowEdges.ref}
      onLayout={windowEdges.onLayout}
      style={containerStyle}
      testID="dictation-overlay"
    >
      {mobileComposer.enabled ? (
        <>
          <EdgeFade edge="bottom" solidFraction={0} backdrop="accent" style={mobileFadeStyle} />
          <View
            pointerEvents="none"
            testID="mobile-recording-background"
            style={mobileBackgroundStyle}
          />
        </>
      ) : null}
      <Pressable
        onPress={handleCancel}
        disabled={actionsDisabled && !isFailed}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.cancel")}
        style={overlayCancelButtonStyle}
      >
        <X size={theme.iconSize.lg} color={theme.colors.accentForeground} strokeWidth={2.5} />
      </Pressable>

      <View
        pointerEvents={touch ? "none" : "auto"}
        style={[
          overlayStyles.centerContainer,
          touch && overlayStyles.touchCenter,
          mobileComposer.enabled && overlayStyles.mobileCenter,
        ]}
      >
        <View style={overlayStyles.meterRow}>
          <VolumeMeter
            volume={volume}
            isMuted={false}
            isSpeaking={false}
            orientation="horizontal"
            color={theme.colors.accentForeground}
          />
          <Text style={overlayTimerTextStyle}>{formatDuration(duration)}</Text>
        </View>
        {status === "paused" ? (
          <Text numberOfLines={2} style={overlayTranscriptTextStyle}>
            {t("message.dictation.paused")}
          </Text>
        ) : null}
        {isFailed ? (
          <Text numberOfLines={2} style={overlayTranscriptTextStyle}>
            {errorText
              ? t("message.dictation.failed", { error: toErrorMessage(errorText) })
              : t("message.dictation.failedRetry")}
          </Text>
        ) : null}
      </View>

      <View style={[overlayStyles.actionButtonsContainer, touch && overlayStyles.touchActions]}>
        {actionsDisabled ? (
          <View style={overlayLoadingStyle}>
            <LoadingSpinner size="small" color={theme.colors.accentForeground} prominent />
          </View>
        ) : null}
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={t("message.dictation.retry")}
            style={overlayRetryButtonStyle}
          >
            <RefreshCcw size={theme.iconSize.lg} color={theme.colors.accent} strokeWidth={2.5} />
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityRole="button"
              accessibilityLabel={t("message.dictation.insert")}
              style={overlayEditButtonStyle}
            >
              <Pencil
                size={theme.iconSize.lg}
                color={theme.colors.accentForeground}
                strokeWidth={2.5}
              />
            </Pressable>
            {queueButton}
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityRole="button"
              accessibilityLabel={t("message.dictation.insertAndSend")}
              style={overlayConfirmButtonStyle}
            >
              <ArrowUp size={theme.iconSize.lg} color={theme.colors.accent} strokeWidth={2.5} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

const BUTTON_SIZE = 32;

const styles = StyleSheet.create((theme) => ({
  micButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  activeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  meterWrapper: {
    width: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  timerText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionButtonCancel: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonConfirm: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  loadingContainer: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;
const MOBILE_SOLID_OVERHANG = 9;
const MOBILE_FADE_HEIGHT = 24;

const overlayStyles = StyleSheet.create((theme) => ({
  // The hidden composer still owns the footprint. Fill it rather than replacing
  // a multiline draft with FOOTER_HEIGHT. Match its border + padding offsets.
  touchContainer: { height: "100%", paddingHorizontal: 0, paddingVertical: 0 },
  mobileContainer: { backgroundColor: "transparent", borderRadius: 0 },
  // Full-bleed to the window's sides and bottom (see useWindowEdges). The top fades into the
  // content above over MOBILE_FADE_HEIGHT instead of meeting the cards with a hard edge.
  mobileBackground: { position: "absolute", top: -MOBILE_SOLID_OVERHANG },
  mobileFade: {
    position: "absolute",
    top: -MOBILE_SOLID_OVERHANG - MOBILE_FADE_HEIGHT,
    height: MOBILE_FADE_HEIGHT,
  },
  touchCancel: {
    position: "absolute",
    left: 7,
    bottom: 7,
  },
  touchSubmit: {
    position: "absolute",
    right: 7,
    bottom: 7,
  },
  touchEdit: {
    position: "absolute",
    right: 7,
  },
  touchActions: { position: "static" },
  touchCenter: { alignSelf: "stretch", paddingHorizontal: 56, paddingTop: 8, paddingBottom: 8 },
  // The background's solid area starts 9px above the field and runs to the window bottom, safe
  // area included. Contents stay on the field, level with the cancel and submit buttons.
  mobileCenter: { paddingTop: 15 },
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    height: FOOTER_HEIGHT,
  },
  cancelButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerContainer: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  meterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  timerText: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  transcriptText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
    paddingHorizontal: theme.spacing[2],
    opacity: 0.9,
  },
  actionButtonsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  loadingContainer: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
}));

const OVERLAY_ACCEPT_BUTTON_BG = { backgroundColor: "rgba(255, 255, 255, 0.25)" };
