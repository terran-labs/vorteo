import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { gridLineSignature, groupGridLines } from "./columns/geometry";
import type { GridRowTracker } from "./grid-row-tracker";

export type { GridRowTracker } from "./grid-row-tracker";

export const CARD_GRID_DATASET = { cardGrid: "" } as const;

/**
 * Measure collapsed tiles against their grid in one batch. Web layout `y` is relative to the DOM
 * parent, and tiles inside layout-transparent groups (`display: contents`) report positions from
 * another coordinate space, so tiles on one line disagreed and phantom rows were reserved.
 */
export function measureGridRows(
  nodes: ReadonlyMap<string, Element>,
  compact: ReadonlyMap<string, number>,
): Map<string, number> {
  const rows = new Map<string, number>();
  let gridTop: number | undefined;
  for (const id of compact.keys()) {
    const node = nodes.get(id);
    if (!node?.isConnected) continue;
    if (gridTop === undefined) {
      const grid = node.closest("[data-card-grid]");
      if (!grid) continue;
      gridTop = grid.getBoundingClientRect().top;
    }
    rows.set(id, Math.round(node.getBoundingClientRect().top - gridTop));
  }
  return rows;
}

function rowSignature(rows: ReadonlyMap<string, number>, compact: ReadonlyMap<string, number>) {
  const tiles = [...rows].map(([id, top]) => ({ id, top, height: compact.get(id) ?? 0 }));
  return gridLineSignature(groupGridLines(tiles));
}

/**
 * Web onLayout comes from a ResizeObserver, so it fires only when a node's own size changes. A
 * tile pushed down by a sibling above keeps a stale row. Any tile or column resize therefore
 * schedules one animation-frame pass that re-reads every collapsed tile, and state changes only
 * when tiles change lines or a line's extent changes, so the resulting reallocation cannot loop.
 */
export function useGridRows(compact: ReadonlyMap<string, number>): GridRowTracker {
  const nodes = useRef(new Map<string, Element>());
  const compactRef = useRef(compact);
  const frame = useRef<number | null>(null);
  const [state, setState] = useState<{ rows: ReadonlyMap<string, number>; signature: string }>({
    rows: new Map(),
    signature: "",
  });
  const run = useCallback(() => {
    frame.current = null;
    for (const [id, node] of nodes.current) if (!node.isConnected) nodes.current.delete(id);
    const rows = measureGridRows(nodes.current, compactRef.current);
    const signature = rowSignature(rows, compactRef.current);
    setState((previous) => (previous.signature === signature ? previous : { rows, signature }));
  }, []);
  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(run);
  }, [run]);
  const onTileLayout = useCallback(
    (id: string, event: LayoutChangeEvent) => {
      const target = (event.nativeEvent as { target?: unknown }).target;
      if (target instanceof Element) nodes.current.set(id, target);
      schedule();
    },
    [schedule],
  );
  useEffect(() => {
    compactRef.current = compact;
    schedule();
  }, [compact, schedule]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return useMemo(
    () => ({ rows: state.rows, onTileLayout, schedule }),
    [state.rows, onTileLayout, schedule],
  );
}

function sameOrder(previous: readonly string[], next: readonly string[]) {
  return previous.length === next.length && previous.every((id, index) => id === next[index]);
}

/** Mount order is not DOM order: late cards and keyed moves must keep their visual neighbors. */
export function useGridOrder() {
  const nodes = useRef(new Map<string, Element>());
  const observer = useRef<MutationObserver | null>(null);
  const frame = useRef<number | null>(null);
  const [order, setOrder] = useState<readonly string[]>([]);
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      for (const [id, node] of nodes.current) if (!node.isConnected) nodes.current.delete(id);
      const next = [...nodes.current]
        .sort((a, b) =>
          a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        )
        .map(([id]) => id);
      setOrder((previous) => (sameOrder(previous, next) ? previous : next));
    });
  }, []);
  const onTileLayout = useCallback(
    (id: string, event: LayoutChangeEvent) => {
      const target = (event.nativeEvent as { target?: unknown }).target;
      if (!(target instanceof Element)) return;
      nodes.current.set(id, target);
      if (!observer.current) {
        const grid = target.closest("[data-card-grid]");
        if (grid) {
          observer.current = new MutationObserver(schedule);
          observer.current.observe(grid, { childList: true, subtree: true });
        }
      }
      schedule();
    },
    [schedule],
  );
  const forget = useCallback(
    (id: string) => {
      nodes.current.delete(id);
      schedule();
    },
    [schedule],
  );
  useEffect(() => {
    // Re-arm after an effect replay even when the existing nodes did not resize.
    const grid = [...nodes.current.values()][0]?.closest("[data-card-grid]");
    if (grid && !observer.current) {
      observer.current = new MutationObserver(schedule);
      observer.current.observe(grid, { childList: true, subtree: true });
    }
    schedule();
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [schedule]);
  return useMemo(() => ({ order, onTileLayout, forget }), [order, onTileLayout, forget]);
}
