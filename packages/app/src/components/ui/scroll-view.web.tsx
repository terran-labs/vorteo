import { forwardRef, useCallback, useRef, type Ref } from "react";
import { FlatList as NativeFlatList, ScrollView as NativeScrollView } from "react-native";
import {
  BottomSheetFlatList as GorhomBottomSheetFlatList,
  BottomSheetScrollView as GorhomBottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import { attachScrollEdgeFade } from "./scroll-edge-fade.web";
import type { SharedFlatListProps, SharedScrollViewProps } from "./scroll-view";

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/** Same names as the React Native types, so `useRef<ScrollView>` keeps working after the swap. */
export type ScrollView = NativeScrollView;
export type FlatList<Item = unknown> = NativeFlatList<Item>;

/** RN Web puts its x/y scrollTo method on the DOM node. Browser libraries use top/left. */
export function installBrowserScrollOptions(node: HTMLElement): () => void {
  const original = node.scrollTo;
  const scrollTo: HTMLElement["scrollTo"] = (options?: ScrollToOptions | number, y?: number) => {
    if (
      typeof options === "object" &&
      options !== null &&
      ("top" in options || "left" in options || "behavior" in options)
    ) {
      Reflect.apply(node.ownerDocument.defaultView!.Element.prototype.scrollTo, node, [options]);
      return;
    }
    Reflect.apply(original, node, [options, y]);
  };
  node.scrollTo = scrollTo;
  return () => {
    if (node.scrollTo === scrollTo) node.scrollTo = original;
  };
}

/**
 * Keep native gesture dependencies out of the browser module. Every shared scroller fades its
 * content at an edge with more to scroll; `edgeFade={false}` opts a code or terminal surface out.
 */
export const ScrollView = forwardRef<NativeScrollView, SharedScrollViewProps>(
  function SharedScrollView({ edgeFade = true, ...props }, ref) {
    const restore = useRef<(() => void) | null>(null);
    const axis = props.horizontal ? "horizontal" : "vertical";
    const setRef = useCallback(
      (instance: NativeScrollView | null) => {
        restore.current?.();
        restore.current = null;
        if (instance) {
          const node = instance.getScrollableNode() as HTMLElement;
          const restoreScroll = installBrowserScrollOptions(node);
          const removeFade = edgeFade ? attachScrollEdgeFade(node, { axis }) : null;
          restore.current = () => {
            restoreScroll();
            removeFade?.();
          };
        }
        assignRef(ref, instance);
      },
      [ref, edgeFade, axis],
    );
    return <NativeScrollView {...props} ref={setRef} />;
  },
);

function FadingFlatList<Item>(
  { edgeFade = true, ...props }: SharedFlatListProps<Item>,
  ref: Ref<NativeFlatList<Item>>,
) {
  const removeFade = useRef<(() => void) | null>(null);
  const axis = props.horizontal ? "horizontal" : "vertical";
  const setRef = useCallback(
    (instance: NativeFlatList<Item> | null) => {
      removeFade.current?.();
      removeFade.current = null;
      const node = instance?.getScrollableNode() as HTMLElement | null | undefined;
      if (node && edgeFade) removeFade.current = attachScrollEdgeFade(node, { axis });
      assignRef(ref, instance);
    },
    [ref, edgeFade, axis],
  );
  return <NativeFlatList {...props} ref={setRef} />;
}

// forwardRef erases the item generic; the list keeps every React Native FlatList method.
export const FlatList = forwardRef(FadingFlatList) as <Item>(
  props: SharedFlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
) => React.ReactElement;

/**
 * Bottom sheet scrollers with the same edge fade. The sheet library forwards its ref to an
 * animated React Native Web ScrollView, which exposes the scrolling DOM node.
 */
function withSheetEdgeFade<C extends React.ComponentType<never>>(Scroller: C, name: string): C {
  const Faded = forwardRef<unknown, { edgeFade?: boolean; horizontal?: boolean | null }>(
    function SheetScroller({ edgeFade = true, ...props }, ref) {
      const removeFade = useRef<(() => void) | null>(null);
      const axis = props.horizontal ? "horizontal" : "vertical";
      const setRef = useCallback(
        (instance: { getScrollableNode?: () => unknown } | null) => {
          removeFade.current?.();
          removeFade.current = null;
          const node = instance?.getScrollableNode?.();
          if (edgeFade && node instanceof HTMLElement) {
            removeFade.current = attachScrollEdgeFade(node, { axis });
          }
          assignRef(ref, instance);
        },
        [ref, edgeFade, axis],
      );
      const Inner = Scroller as unknown as React.ComponentType<Record<string, unknown>>;
      return <Inner {...props} ref={setRef} />;
    },
  );
  Faded.displayName = name;
  return Faded as unknown as C;
}

export const BottomSheetScrollView = withSheetEdgeFade(
  GorhomBottomSheetScrollView,
  "BottomSheetScrollView",
);
export const BottomSheetFlatList = withSheetEdgeFade(
  GorhomBottomSheetFlatList,
  "BottomSheetFlatList",
);
