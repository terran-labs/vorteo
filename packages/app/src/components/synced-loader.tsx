import { useLayoutEffect, useMemo, useState } from "react";
import { View } from "react-native";
import Animated, {
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  SYNCED_LOADER_COLUMNS,
  SYNCED_LOADER_DOT_COUNT,
  getSyncedLoaderDotOpacity,
} from "@/components/synced-loader-state";

const DOT_KEYS = Array.from({ length: SYNCED_LOADER_DOT_COUNT }, (_, i) => `dot-${i}`);
// Reduced motion freezes the grid on this frame; any fixed instant shows a few lit dots.
const REDUCED_MOTION_TIME_MS = 0;
// One app-wide frame clock: a single requestAnimationFrame loop on the UI thread feeds
// every visible loader, so adding loaders adds style worklets, not timers.
const sharedTime = makeMutable(0);
const activeLoaderCount = makeMutable(0);
const clockRunning = makeMutable(false);
let nextTimeListenerId = 1;

function advanceSharedTime(): void {
  "worklet";
  if (activeLoaderCount.value === 0) {
    clockRunning.value = false;
    return;
  }

  sharedTime.value = Date.now();
  requestAnimationFrame(advanceSharedTime);
}

function registerTimeListener(
  time: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  time.value = Date.now();
  sharedTime.addListener(listenerId, (nextTime) => {
    time.value = nextTime;
  });
  activeLoaderCount.value += 1;

  if (!clockRunning.value) {
    clockRunning.value = true;
    sharedTime.value = time.value;
    requestAnimationFrame(advanceSharedTime);
  }
}

function unregisterTimeListener(registered: SharedValue<boolean>, listenerId: number): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  sharedTime.removeListener(listenerId);
  activeLoaderCount.value -= 1;
}

function useSyncedLoaderTime(active: boolean, reduceMotion: boolean): SharedValue<number> {
  // The local value lets retained loaders detach from the app-wide clock without
  // unmounting their animated views or leaving hidden style worklets subscribed.
  const time = useSharedValue(reduceMotion ? REDUCED_MOTION_TIME_MS : Date.now());
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextTimeListenerId++);

  useLayoutEffect(() => {
    if (!active || reduceMotion) {
      return;
    }

    scheduleOnUI(registerTimeListener, time, registered, listenerId);
    return () => {
      scheduleOnUI(unregisterTimeListener, registered, listenerId);
    };
  }, [active, listenerId, reduceMotion, registered, time]);

  return time;
}

export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const time = useSyncedLoaderTime(active, reduceMotion);

  // The 3x3 grid fills `size` exactly: the dot is whatever is left after the two gaps,
  // not a floored integer. Flooring cost the grid up to a third of a dot per row and
  // read as a small mark in a large slot. Fractional dots are fine here; these are
  // sub-pixel radii on a moving glyph.
  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, (size - gap * 2) / SYNCED_LOADER_COLUMNS);
  const gridSide = dotSize * SYNCED_LOADER_COLUMNS + gap * (SYNCED_LOADER_COLUMNS - 1);

  const gridStyle = useMemo(() => ({ width: gridSide, height: gridSide }), [gridSide]);
  const containerStyle = useMemo(
    () =>
      ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }) as const,
    [size],
  );

  return (
    <View style={containerStyle}>
      <View style={gridStyle}>
        {Array.from({ length: SYNCED_LOADER_DOT_COUNT }).map((_, dotIndex) => {
          const rowIndex = Math.floor(dotIndex / SYNCED_LOADER_COLUMNS);
          const columnIndex = dotIndex % SYNCED_LOADER_COLUMNS;

          return (
            <SpinnerDot
              key={DOT_KEYS[dotIndex]}
              color={color}
              dotSize={dotSize}
              dotIndex={dotIndex}
              time={time}
              left={columnIndex * (dotSize + gap)}
              top={rowIndex * (dotSize + gap)}
            />
          );
        })}
      </View>
    </View>
  );
}

function SpinnerDot({
  color,
  dotSize,
  dotIndex,
  time,
  left,
  top,
}: {
  color: string;
  dotSize: number;
  dotIndex: number;
  time: SharedValue<number>;
  left: number;
  top: number;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: getSyncedLoaderDotOpacity(time.value, dotIndex),
  }));

  const dotStyle = useMemo(
    () => [
      animatedStyle,
      {
        width: dotSize,
        height: dotSize,
        borderRadius: dotSize / 2,
        backgroundColor: color,
        position: "absolute" as const,
        left,
        top,
      },
    ],
    [animatedStyle, dotSize, color, left, top],
  );

  return <Animated.View style={dotStyle} />;
}
