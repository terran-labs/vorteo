import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useWindowDimensions } from "@/appearance/interface-geometry";
import { DraggedCardHeightHandle, useDraggedCardHeight } from "@/components/card-height-handle";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { TaskCard, TaskCardBodyInsetContext, TaskCardHeader } from "@/agent-stream/task-card";
import { TASK_CARD_BOTTOM_INSET } from "@/agent-stream/task-card-styles";
import { CountBadge } from "@/components/ui/count-badge";
import { usePanelStore } from "@/stores/panel-store";
import { SUPPORTING_CARD_DEFAULTS } from "@/stores/panel-store/state";
import { SidebarInsetContext, SidebarSectionRule } from "./sidebar-separator";

/** Cards that span every thread and account, as opposed to the focused tab's right-hand cards. */
export type GlobalCardKind = "globalQuestions" | "globalQuota";
const GLOBAL_CARD_KINDS: readonly GlobalCardKind[] = ["globalQuestions", "globalQuota"];

/** Below this height, one card opens at a time so the workspace list keeps its room. */
const EXCLUSIVE_HEIGHT = 720;

interface GlobalCardLayout {
  exclusive: boolean;
  maxBodyHeight: number;
  /** Cards currently shown; a hidden card never closes a visible one. */
  shown: ReadonlySet<GlobalCardKind>;
  setShown: (kind: GlobalCardKind, shown: boolean) => void;
}
export const GlobalCardLayoutContext = createContext<GlobalCardLayout>({
  exclusive: false,
  maxBodyHeight: 240,
  shown: new Set(),
  setShown: () => {},
});

/** Each card body is capped so the cards never take more than about half of the sidebar. */
export function globalCardLayout(
  windowHeight: number,
): Pick<GlobalCardLayout, "exclusive" | "maxBodyHeight"> {
  const exclusive = windowHeight < EXCLUSIVE_HEIGHT;
  const share = exclusive ? 0.4 : 0.25;
  return { exclusive, maxBodyHeight: Math.max(120, Math.round(windowHeight * share)) };
}

/** The device remembers each card's state; small screens close the others when one opens. */
export function useGlobalCardDisclosure(kind: GlobalCardKind) {
  const { exclusive, shown, setShown } = useContext(GlobalCardLayoutContext);
  useLayoutEffect(() => {
    setShown(kind, true);
    return () => setShown(kind, false);
  }, [kind, setShown]);
  const expanded = usePanelStore((state) => {
    const open = (card: GlobalCardKind) =>
      state.supportingCardExpanded[card] ?? SUPPORTING_CARD_DEFAULTS[card];
    if (!open(kind)) return false;
    // Choices saved on a taller screen may leave several open; the first in order wins here.
    return (
      !exclusive ||
      GLOBAL_CARD_KINDS.slice(0, GLOBAL_CARD_KINDS.indexOf(kind)).every(
        (card) => !shown.has(card) || !open(card),
      )
    );
  });
  const toggle = useCallback(() => {
    const store = usePanelStore.getState();
    const next = !expanded;
    store.setSupportingCardExpanded(kind, next, "sidebar");
    if (next && exclusive) {
      for (const other of GLOBAL_CARD_KINDS) {
        if (other !== kind) store.setSupportingCardExpanded(other, false, "sidebar");
      }
    }
  }, [exclusive, expanded, kind]);
  return [expanded, toggle] as const;
}

const SectionContext = createContext(false);

/**
 * How far a divider inside a footer section extends past its content to reach the navigation
 * card's edges. Apply it as a negative horizontal margin with matching extra padding, so the line
 * spans the card while the content stays put. Zero outside a section.
 */
export function useSectionDividerBleed(): number {
  const inSection = useContext(SectionContext);
  const sidebarInset = useContext(SidebarInsetContext);
  const bodyInset = useContext(TaskCardBodyInsetContext);
  return inSection ? sidebarInset + bodyInset : 0;
}

/** Margin and padding that carry a top divider to the card edges; `padding` is the content's own. */
export function sectionDividerBleedStyle(bleed: number, padding = 0) {
  return bleed > 0 ? { marginHorizontal: -bleed, paddingHorizontal: padding + bleed } : null;
}

/** Dragging never lets the cards take more than this share of the window. */
const MAX_DRAGGED_SHARE = 0.75;

/**
 * A collapsible section of the sidebar footer block. It sits inside the navigation card without
 * its own card chrome, below a partial-width rule. While open, that rule is the section's resize
 * grip: dragging it up grows the body, and a double press returns to automatic height.
 */
export function GlobalCard({
  kind,
  title,
  icon,
  count,
  countLabel,
  testID,
  children,
}: {
  kind: GlobalCardKind;
  title: string;
  icon: ReactNode;
  count: number;
  countLabel: string;
  testID: string;
  children: ReactNode;
}) {
  const [expanded, toggle] = useGlobalCardDisclosure(kind);
  const { maxBodyHeight } = useContext(GlobalCardLayoutContext);
  const badge = useMemo(
    () => (
      <CountBadge
        count={count}
        label={String(count)}
        accessibilityLabel={countLabel}
        testID={`${testID}-count`}
      />
    ),
    [count, countLabel, testID],
  );
  const { height: windowHeight } = useWindowDimensions();
  const dragged = useDraggedCardHeight(testID);
  const [bodyHeight, setBodyHeight] = useState(0);
  const maxDraggedHeight = Math.round(windowHeight * MAX_DRAGGED_SHARE);
  // A height dragged on a taller window still leaves the workspace list its room here.
  const bodyStyle = useMemo(
    () =>
      dragged.height === undefined
        ? { maxHeight: maxBodyHeight }
        : { height: Math.min(dragged.height, maxDraggedHeight) },
    [dragged.height, maxBodyHeight, maxDraggedHeight],
  );
  const onBodyLayout = useCallback((event: LayoutChangeEvent) => {
    setBodyHeight(event.nativeEvent.layout.height);
  }, []);
  return (
    <View testID={`${testID}-section`}>
      <SidebarSectionRule testID={`${testID}-rule`}>
        {expanded ? (
          <DraggedCardHeightHandle
            card={dragged}
            cardKey={testID}
            height={bodyHeight}
            maxHeight={maxDraggedHeight}
            placement="divider"
          />
        ) : null}
      </SidebarSectionRule>
      <TaskCard
        scrollBody={false}
        flushBody
        testID={testID}
        bodyVisible={expanded}
        style={styles.section}
      >
        <TaskCardHeader>
          <CardDisclosure
            icon={icon}
            title={title}
            expanded={expanded}
            onPress={toggle}
            count={badge}
            testID={`${testID}-toggle`}
          />
        </TaskCardHeader>
        {expanded ? (
          <SectionBody style={bodyStyle} onLayout={onBodyLayout} testID={`${testID}-body-scroll`}>
            {children}
          </SectionBody>
        ) : null}
      </TaskCard>
    </View>
  );
}

/**
 * The scrolling body spans the navigation card's full width, so dividers inside it can reach the
 * card edges without being clipped; its content padding puts everything else back in place.
 */
function SectionBody({
  style,
  onLayout,
  testID,
  children,
}: {
  style: { maxHeight: number } | { height: number };
  onLayout: (event: LayoutChangeEvent) => void;
  testID: string;
  children: ReactNode;
}) {
  const bleed = useContext(SidebarInsetContext) + useContext(TaskCardBodyInsetContext);
  const layout = useMemo(
    () => ({
      scroll: [style, styles.flushScroll, { marginHorizontal: -bleed }],
      content: { paddingHorizontal: bleed },
    }),
    [bleed, style],
  );
  return (
    <ScrollView
      style={layout.scroll}
      contentContainerStyle={layout.content}
      onLayout={onLayout}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      <SectionContext.Provider value>{children}</SectionContext.Provider>
    </ScrollView>
  );
}

// The navigation card supplies the surface; a section only contributes its rule and content.
const styles = StyleSheet.create({
  section: { backgroundColor: "transparent", borderWidth: 0, borderRadius: 0 },
  // Scrolling content runs to the next section's rule instead of stopping at the body inset.
  flushScroll: { marginBottom: -TASK_CARD_BOTTOM_INSET },
});
