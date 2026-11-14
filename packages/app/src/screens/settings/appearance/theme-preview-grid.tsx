import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useWindowDimensions } from "@/appearance/interface-geometry";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useThemePreview, useThemePreviewActive } from "@/appearance/provider";
import { useAppSettings } from "@/hooks/use-settings";
import {
  APPEARANCE_DEFINITIONS,
  type AppearanceDefinition,
  type AppearanceId,
} from "@/styles/appearance-catalog";
import { THEME_OPTIONS } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useVortonTouch } from "@/vorton-touch";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemePreviewArtwork } from "./theme-preview-artwork";

import { InterfaceZoomControl } from "./interface-zoom-control";

const previewDataset = { ptheme: true };

// Freed's bubble geometry: resting pills lift on hover, and the selected
// theme stands as a circle-like capsule that fills the row height.
function bubbleHeight(selected: boolean, lifted: boolean, compact: boolean): number {
  if (selected) return compact ? 35.2 : 38.4;
  if (lifted) return compact ? 26.4 : 28.8;
  return compact ? 17.6 : 19.2;
}

// Hover deepens the blurred drop shadow; the selected theme gets a ring and glow.
function bubbleShadow(selected: boolean, lifted: boolean, ring: string): string {
  if (selected) {
    return `0 0 0 2px rgba(0,0,0,0.28), 0 0 0 4px color-mix(in srgb, ${ring} 68%, transparent), 0 10px 24px rgba(0,0,0,0.18), 0 0 28px color-mix(in srgb, ${ring} 32%, transparent)`;
  }
  if (lifted) return "0 0 0 1px rgba(255,255,255,0.1), 0 10px 24px rgba(0,0,0,0.22)";
  return "0 0 0 1px rgba(255,255,255,0.04), 0 0 0 rgba(0,0,0,0)";
}

interface ThemePreviewCardProps {
  compact?: boolean;
  appearance: AppearanceDefinition;
  selected: boolean;
  /** The one radio Tab reaches: the checked one, or the first when none is checked. */
  tabStop: boolean;
  pending: boolean;
  onCommit: (id: AppearanceId) => void;
}

function ThemePreviewCard({
  appearance,
  selected,
  tabStop,
  pending,
  onCommit,
  compact: forceCompact,
}: ThemePreviewCardProps) {
  const preview = useThemePreview();
  const touch = useVortonTouch();
  const { width } = useWindowDimensions();
  const hovered = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lifted, setLifted] = useState(false);
  const [surfaceWidth, setSurfaceWidth] = useState(48);
  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => {
    if (pending) clearTimer();
  }, [clearTimer, pending]);
  useEffect(() => {
    if (!isWeb) return clearTimer;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearTimer();
    };
    window.addEventListener("keydown", cancel, true);
    return () => {
      clearTimer();
      window.removeEventListener("keydown", cancel, true);
    };
  }, [clearTimer]);
  const stopPreview = useCallback(() => {
    clearTimer();
    preview((current) => (current === appearance.id ? null : current));
  }, [appearance.id, clearTimer, preview]);
  const enter = useCallback(() => {
    hovered.current = true;
    if (touch || pending) return;
    setLifted(true);
    clearTimer();
    timer.current = setTimeout(() => preview(appearance.id), 180);
  }, [appearance.id, clearTimer, pending, preview, touch]);
  // Focus lifts the bubble but does not preview: tabbing or arrowing through the group must not
  // repaint the whole app on every stop. Arrow keys select, which applies the theme for real.
  const focus = useCallback(() => {
    focused.current = true;
    if (touch || pending) return;
    setLifted(true);
  }, [pending, touch]);
  const leave = useCallback(() => {
    hovered.current = false;
    if (focused.current) return;
    setLifted(false);
    stopPreview();
  }, [stopPreview]);
  const blur = useCallback(() => {
    focused.current = false;
    if (hovered.current) return;
    setLifted(false);
    stopPreview();
  }, [stopPreview]);
  const commit = useCallback(() => {
    clearTimer();
    onCommit(appearance.id);
  }, [appearance.id, clearTimer, onCommit]);
  const option = THEME_OPTIONS.find((item) => item.name === appearance.id);
  if (!option || !("theme" in option)) throw new Error("Missing built-in theme");
  const palette = option.theme.colors;
  const compact = forceCompact || width < 640;
  const swatchHeight = bubbleHeight(selected, lifted, compact);
  const accessibilityState = useMemo(
    () => ({ checked: selected, disabled: pending }),
    [pending, selected],
  );
  const measure = useCallback(
    (event: LayoutChangeEvent) => setSurfaceWidth(Math.round(event.nativeEvent.layout.width)),
    [],
  );
  const fillStyle = useMemo(
    () => [
      styles.swatch,
      {
        height: swatchHeight,
        borderColor: selected ? palette.ring : "rgba(255,255,255,0.42)",
        opacity: selected || lifted ? 1 : 0.9,
      },
      inlineUnistylesStyle({
        backgroundColor: palette.accent,
        ...(isWeb
          ? {
              backgroundImage: appearance.previewGradient,
              transform: [{ scale: lifted ? 1.05 : 1 }],
              boxShadow: bubbleShadow(selected, lifted, palette.ring),
            }
          : {}),
      }),
    ],
    [appearance.previewGradient, lifted, palette.accent, palette.ring, selected, swatchHeight],
  );
  // Button children are text. Keep graphics outside that wrapper so native text
  // layout cannot squeeze the swatch width.
  const swatch = useMemo(
    () => (
      <View
        style={fillStyle}
        onLayout={isWeb ? undefined : measure}
        testID={`theme-preview-surface-${appearance.id}`}
      >
        <ThemePreviewArtwork
          appearance={appearance.id}
          width={surfaceWidth}
          height={swatchHeight}
        />
        <View style={styles.sheen} />
      </View>
    ),
    [appearance.id, fillStyle, measure, surfaceWidth, swatchHeight],
  );
  return (
    <View
      style={styles.hoverTarget}
      onPointerEnter={enter}
      onPointerLeave={leave}
      dataSet={previewDataset}
    >
      <Tooltip delayDuration={180} enabledOnMobile>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            style={styles.card}
            onPress={commit}
            onFocus={focus}
            onBlur={blur}
            disabled={pending}
            accessibilityLabel={`${appearance.name}. ${appearance.description}`}
            accessibilityRole="radio"
            accessibilityState={accessibilityState}
            aria-checked={selected}
            tabIndex={tabStop ? 0 : -1}
            testID={`theme-preview-${appearance.id}`}
            trailing={swatch}
          />
        </TooltipTrigger>
        <TooltipContent>
          <TooltipText
            label={appearance.name}
            description={`${appearance.tagline} ${appearance.description}`}
          />
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const RADIO_KEYS = new Set(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]);

/**
 * Radio-group keys on web: arrows, Home and End move focus to a radio and select it, wrapping at
 * the ends; Space selects the focused one. Modified keys belong to app shortcuts. Native screen
 * readers move between radios themselves, so this is web only.
 */
function moveRadioFocus(group: HTMLElement, event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target as HTMLElement | null;
  if (event.key === " " && target?.getAttribute("role") === "radio") {
    event.preventDefault();
    target.click();
    return;
  }
  if (!RADIO_KEYS.has(event.key)) return;
  // Claim the key even while a theme saves and every radio is disabled, so the page never scrolls.
  event.preventDefault();
  const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).filter(
    (radio) => radio.getAttribute("aria-disabled") !== "true",
  );
  if (radios.length === 0) return;
  const current = radios.findIndex((radio) => radio === document.activeElement);
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = radios.length - 1;
  else if (event.key === "ArrowRight" || event.key === "ArrowDown")
    next = (current + 1) % radios.length;
  else next = (current - 1 + radios.length) % radios.length;
  radios[next].focus();
  radios[next].click();
}

export function ThemePreviewGrid({
  compact = false,
  selectTheme,
}: { compact?: boolean; selectTheme?: (action: () => void) => void } = {}) {
  const { t } = useTranslation();
  const previewing = useThemePreviewActive();
  const { settings, updateSettings } = useAppSettings();
  const preview = useThemePreview();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => preview(null), [preview]);
  useEffect(() => {
    if (!isWeb) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !previewing) return;
      event.preventDefault();
      event.stopPropagation();
      preview(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
    };
  }, [preview, previewing]);
  const commit = useCallback(
    async (id: AppearanceId | "auto") => {
      setSaving(true);
      setError(null);
      try {
        await updateSettings({ theme: id });
        preview(null);
      } catch {
        preview(null);
        setError("Could not save the theme. Try again.");
      } finally {
        setSaving(false);
      }
    },
    [preview, updateSettings],
  );
  const select = useCallback(
    (id: AppearanceId | "auto") => {
      if (selectTheme)
        selectTheme(() => {
          void commit(id);
        });
      else void commit(id);
    },
    [commit, selectTheme],
  );
  const followSystem = useCallback(() => select("auto"), [select]);
  const groupRef = useRef<View>(null);
  useEffect(() => {
    if (!isWeb) return;
    // On web a View ref is its DOM element.
    const group = groupRef.current as unknown as HTMLElement | null;
    if (!group) return;
    const onKeyDown = (event: KeyboardEvent) => moveRadioFocus(group, event);
    group.addEventListener("keydown", onKeyDown);
    return () => group.removeEventListener("keydown", onKeyDown);
  }, []);
  const followsSystem = settings.theme === "auto";
  const anyBuiltinChecked =
    followsSystem || APPEARANCE_DEFINITIONS.some((appearance) => appearance.id === settings.theme);
  const followSystemState = useMemo(
    () => ({ checked: followsSystem, disabled: saving }),
    [followsSystem, saving],
  );
  return (
    <View style={styles.controls}>
      {/* One choice: Follow system first, then each theme, as radios with arrow-key movement. */}
      <View
        ref={groupRef}
        accessibilityRole="radiogroup"
        accessibilityLabel={t("settings.appearance.theme.title")}
        style={styles.choices}
        testID="theme-radio-group"
      >
        <Button
          variant={followsSystem ? "default" : "outline"}
          onPress={followSystem}
          disabled={saving}
          accessibilityRole="radio"
          accessibilityState={followSystemState}
          aria-checked={followsSystem}
          tabIndex={followsSystem || !anyBuiltinChecked ? 0 : -1}
          testID="theme-follow-system"
        >
          {t("vorteoSetup.followSystem")}
        </Button>
        <View style={styles.grid}>
          {APPEARANCE_DEFINITIONS.map((appearance) => (
            <ThemePreviewCard
              key={appearance.id}
              compact={compact}
              appearance={appearance}
              selected={settings.theme === appearance.id}
              tabStop={settings.theme === appearance.id}
              pending={saving}
              onCommit={select}
            />
          ))}
        </View>
      </View>
      <InterfaceZoomControl />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { width: "100%", maxWidth: 376, flexShrink: 1, gap: 12 },
  choices: { gap: 12 },
  // One row of equal columns, as in Freed's view menu. Bubbles shrink with the container and
  // only wrap when the 44px touch minimum no longer fits, such as at 320px wide.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 4,
  },
  // Columns share the row but never shrink below a 44px target, so at 320px they wrap instead of
  // overlapping.
  hoverTarget: { position: "relative", flexGrow: 1, flexBasis: 44, minWidth: 44 },
  // A column, so the bubble sits on the card's vertical centerline at every height. As a
  // web button the card is otherwise a row, which pins a shorter bubble to the top.
  card: {
    flexDirection: "column",
    width: "100%",
    minWidth: 0,
    padding: 0,
    // Override the button's responsive inline padding as well as its shorthand.
    paddingHorizontal: 0,
    borderWidth: 0,
    borderRadius: 25,
    height: 44,
    minHeight: 44,
    alignItems: "stretch",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  swatch: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1.5,
    overflow: "hidden",
    ...(isWeb
      ? {
          backdropFilter: "blur(18px)",
          transitionProperty: "height, transform, box-shadow, opacity",
          transitionDuration: "240ms",
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        }
      : {}),
  },
  sheen: {
    position: "absolute",
    left: 4,
    right: 4,
    top: 2,
    height: 5,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  error: { color: theme.colors.statusDanger, padding: 12 },
}));
