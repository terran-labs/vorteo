import { useCallback, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { GridRowTracker } from "./grid-row-tracker";

export type { GridRowTracker } from "./grid-row-tracker";

/** Native grids need no marker; web uses it to find the grid node. */
export const CARD_GRID_DATASET = undefined;

/**
 * Native layout `y` is already relative to the grid line, and native onLayout fires when a view
 * moves, so each tile reports its own row.
 */
export function useGridRows(_compact: ReadonlyMap<string, number>): GridRowTracker {
  const [rows, setRows] = useState<ReadonlyMap<string, number>>(new Map());
  const onTileLayout = useCallback((id: string, event: LayoutChangeEvent) => {
    const { width, y } = event.nativeEvent.layout;
    if (width <= 0) return;
    const row = Math.round(y);
    setRows((previous) => {
      if (previous.get(id) === row) return previous;
      return new Map(previous).set(id, row);
    });
  }, []);
  const schedule = useCallback(() => {}, []);
  return useMemo(() => ({ rows, onTileLayout, schedule }), [rows, onTileLayout, schedule]);
}

/** Native onLayout reports sibling moves, including keyed reorders without a resize. */
export function useGridOrder() {
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const [order, setOrder] = useState<readonly string[]>([]);
  const onTileLayout = useCallback((id: string, event: LayoutChangeEvent) => {
    const { x, y, width } = event.nativeEvent.layout;
    if (width <= 0) return;
    positions.current.set(id, { x, y });
    const next = [...positions.current]
      .sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x)
      .map(([key]) => key);
    setOrder((previous) =>
      previous.length === next.length && previous.every((key, i) => key === next[i])
        ? previous
        : next,
    );
  }, []);
  const forget = useCallback((id: string) => {
    positions.current.delete(id);
    setOrder((previous) =>
      previous.includes(id) ? previous.filter((key) => key !== id) : previous,
    );
  }, []);
  return useMemo(() => ({ order, onTileLayout, forget }), [order, onTileLayout, forget]);
}
