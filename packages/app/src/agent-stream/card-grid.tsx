import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle, type LayoutChangeEvent } from "react-native";
import { CARD_GAP } from "./columns/geometry";
import { usePanelSpacing } from "@/styles/use-panel-spacing";
import { CARD_GRID_DATASET, useGridOrder } from "./grid-row";

export const CardGridContext = createContext(false);
export const CardGridInsetContext = createContext(2);
interface TileLayout {
  widths: ReadonlyMap<string, number>;
  forget: (id: string) => void;
  onTileLayout: (id: string, event: LayoutChangeEvent) => void;
  register: (id: string, compact: boolean | null) => void;
}
export const CardGridLayoutContext = createContext<TileLayout | null>(null);
const MIN_TILE_WIDTH = 80;

function balancedWidths(
  tiles: ReadonlyMap<string, boolean>,
  width: number,
  order: readonly string[],
) {
  const widths = new Map<string, number>();
  if (width <= 0) return widths;
  const capacity = Math.max(1, Math.floor((width + CARD_GAP) / (MIN_TILE_WIDTH + CARD_GAP)));
  let run: string[] = [];
  function flush() {
    if (run.length === 0) return;
    const rows = Math.ceil(run.length / capacity);
    const columns = Math.ceil(run.length / rows);
    const basis = (width - CARD_GAP * (columns - 1)) / columns;
    for (const id of run) widths.set(id, basis);
    run = [];
  }
  for (const id of order) {
    if (!tiles.has(id)) continue;
    if (tiles.get(id)) run.push(id);
    else flush();
  }
  flush();
  return widths;
}

export const CardTileContext = createContext({ compact: false, width: Infinity });

/** Flex lines preserve card identity while expanded cards break adjacent collapsed runs. */
export function CardGrid({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { inset, onLayout: onPanelLayout } = usePanelSpacing();
  const { order, onTileLayout, forget } = useGridOrder();
  const [width, setWidth] = useState(0);
  const [tiles, setTiles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const register = useCallback((id: string, compact: boolean | null) => {
    setTiles((previous) => {
      if (compact === null ? !previous.has(id) : previous.get(id) === compact) return previous;
      const next = new Map(previous);
      if (compact === null) next.delete(id);
      else next.set(id, compact);
      return next;
    });
  }, []);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onPanelLayout(event);
      if (event.nativeEvent.layout.width > 0) setWidth(event.nativeEvent.layout.width);
    },
    [onPanelLayout],
  );
  const layout = useMemo(
    () => ({ widths: balancedWidths(tiles, width, order), register, onTileLayout, forget }),
    [tiles, width, order, register, onTileLayout, forget],
  );
  return (
    <CardGridContext value={true}>
      <CardGridLayoutContext value={layout}>
        <CardGridInsetContext value={inset}>
          <View
            style={[gridStyle, style]}
            testID={testID}
            onLayout={onLayout}
            dataSet={CARD_GRID_DATASET}
          >
            {children}
          </View>
        </CardGridInsetContext>
      </CardGridLayoutContext>
    </CardGridContext>
  );
}

const gridStyle = {
  flexDirection: "row",
  flexWrap: "wrap",
  alignContent: "flex-start",
  alignItems: "flex-start",
  rowGap: CARD_GAP,
  columnGap: CARD_GAP,
  width: "100%",
  minWidth: 0,
} as const;

// Layout-transparent groups keep their mounted children in the surrounding grid.
export const cardGridGroupStyle = { display: "contents" } as const;
export const cardGridExpandedStyle = { width: "100%", minWidth: 0, flexShrink: 0 } as const;
export const cardGridCollapsedStyle = {
  flexBasis: 0,
  flexGrow: 1,
  minWidth: MIN_TILE_WIDTH,
} as const;
