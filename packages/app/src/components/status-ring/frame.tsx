import type { ReactNode } from "react";
import { StyleSheet as RNStyleSheet, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { RadarRing } from "@/components/ui/radar-ring";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { followRowSurface } from "@/styles/hover";
import { getStatusDotColor } from "@/utils/status-dot-color";
import {
  STATUS_RING_FRAME_SIZE,
  STATUS_RING_HEAD_OPACITY,
  STATUS_RING_SIZE,
  STATUS_RING_STROKE,
  STATUS_RING_TRACK_OPACITY,
} from "@/components/status-ring/geometry";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

export interface StatusRingProps {
  variant?: "agent" | "task";
  /** "calm": a task ring drawn in the muted color calm sidebar rows use for text and icons. */
  tone?: "calm";
  /** "calm": turns at a third of the default rate, as sidebar rows do. */
  tempo?: "calm";
  // The surface the ring is drawn on top of, named rather than resolved, because theme colours
  // are only legible inside `StyleSheet.create` — see docs/unistyles.md. The frame fills itself
  // with this so the ring reads as a hole punched in whatever it overlaps: the agent icon under a
  // tab dot, the project tile under a sidebar badge. Leave it out where the ring sits on flat
  // background and has nothing to knock out.
  backdrop?: SurfaceBackdrop | null;
}

/** Shared ring geometry; task activity uses a foreground outline without the agent dot. */
export function StatusRingFrame({
  backdrop,
  variant = "agent",
  children,
}: StatusRingProps & { children: ReactNode }) {
  return (
    <View
      testID={variant === "task" ? "task-running-spinner" : "agent-running-spinner"}
      style={[styles.frame, getBackdropStyle(backdrop)]}
    >
      {children}
      {variant === "agent" ? <View style={styles.centerDot} /> : null}
    </View>
  );
}

const AgentRadar = withUnistyles(RadarRing, (theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? theme.colors.foreground,
}));
const TaskRadar = withUnistyles(RadarRing, (theme) => ({ color: theme.colors.foreground }));
const CalmTaskRadar = withUnistyles(RadarRing, (theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));

export function StatusRingArc({ variant, tone }: Pick<StatusRingProps, "variant" | "tone">) {
  let Ring = variant === "task" ? TaskRadar : AgentRadar;
  if (variant === "task" && tone === "calm") Ring = CalmTaskRadar;
  return (
    <Ring
      size={STATUS_RING_SIZE}
      strokeWidth={STATUS_RING_STROKE}
      trackOpacity={STATUS_RING_TRACK_OPACITY}
      headOpacity={variant === "task" ? 1 : STATUS_RING_HEAD_OPACITY}
    />
  );
}

function getBackdropStyle(backdrop: SurfaceBackdrop | null | undefined) {
  switch (backdrop) {
    case "surface0":
      return styles.backdropSurface0;
    case "surface1":
      return styles.backdropSurface1;
    case "surfaceSidebar":
      return styles.backdropSurfaceSidebar;
    case "surfaceSidebarHover":
      return styles.backdropSurfaceSidebarHover;
    case "surfaceSidebarSelected":
      return styles.backdropSurfaceSidebarSelected;
    case "surface2":
      return styles.backdropSurface2;
    default:
      return null;
  }
}

// The rotating sweep's geometry, deliberately plain React Native rather than Unistyles: on
// native this style lands on a Reanimated `Animated.View`, and applying a theme-tracked style to
// one crashes when the theme changes — Unistyles and Reanimated both mutate the same native node.
// See docs/unistyles.md. The colour it needs lives on `StatusRingArc`, one level in, on a view
// Reanimated never touches.
export const rotatorStyles = RNStyleSheet.create({
  rotator: {
    position: "absolute",
    width: STATUS_RING_SIZE,
    height: STATUS_RING_SIZE,
  },
});

export const styles = StyleSheet.create((theme) => {
  const runningColor = getStatusDotColor({ theme, bucket: "running" }) ?? undefined;

  return {
    frame: {
      width: STATUS_RING_FRAME_SIZE,
      height: STATUS_RING_FRAME_SIZE,
      borderRadius: theme.borderRadius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    // On web the halo follows the containing row's published surface (ROW_SURFACE_VAR), so it
    // matches a CSS hover fill; the named backdrop is the fallback outside such rows.
    backdropSurface0: followRowSurface(theme.colors.surface0),
    backdropSurface1: followRowSurface(theme.colors.surface1),
    backdropSurfaceSidebar: followRowSurface(theme.colors.surfaceSidebar),
    backdropSurfaceSidebarHover: followRowSurface(theme.colors.surfaceSidebarHover),
    backdropSurfaceSidebarSelected: followRowSurface(theme.colors.surfaceSidebarSelected),
    backdropSurface2: followRowSurface(theme.colors.surface2),

    centerDot: {
      width: STATUS_INDICATOR_FILLED_DOT_SIZE,
      height: STATUS_INDICATOR_FILLED_DOT_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: runningColor,
    },
  };
});
