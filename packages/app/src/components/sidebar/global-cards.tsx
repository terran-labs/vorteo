import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlobalOpenQuestionsCard } from "@/open-questions/global-card";
import { usePanelStore } from "@/stores/panel-store";
import { useReportSectionsShown } from "./footer-rules";
import {
  GLOBAL_CARD_KINDS,
  GlobalCardLayoutContext,
  globalCardLayout,
  isSectionExpanded,
  type GlobalCardKind,
} from "./global-card-shell";
import { SidebarSectionRule } from "./sidebar-separator";

/**
 * Quotas live in the identity row as timelines, so this holds the remaining sections.
 *
 * The global sections at the top of the sidebar footer block, inside the navigation card between
 * the workspace list and the footer rows. Each section hides itself, with its rule, while it has
 * nothing to show, so an idle installation keeps the full list. A rule follows the sections only
 * while the last one is open, where it clips that section's scrolling body.
 */
export function SidebarGlobalCards({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { height } = useWindowDimensions();
  const [shown, setShownState] = useState<ReadonlySet<GlobalCardKind>>(() => new Set());
  const setShown = useCallback((kind: GlobalCardKind, visible: boolean) => {
    setShownState((current) => {
      if (current.has(kind) === visible) return current;
      const next = new Set(current);
      if (visible) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);
  const layout = useMemo(
    () => ({ ...globalCardLayout(height), shown, setShown }),
    [height, setShown, shown],
  );
  const last = GLOBAL_CARD_KINDS.findLast((kind) => shown.has(kind));
  const lastOpen = usePanelStore((state) =>
    last ? isSectionExpanded(state, last, layout.exclusive, shown) : false,
  );
  const reportShown = useReportSectionsShown();
  const anyShown = shown.size > 0;
  useLayoutEffect(() => {
    reportShown?.(anyShown);
  }, [anyShown, reportShown]);
  useLayoutEffect(() => () => reportShown?.(false), [reportShown]);
  return (
    <GlobalCardLayoutContext.Provider value={layout}>
      <View style={styles.stack} testID="sidebar-global-cards">
        <GlobalOpenQuestionsCard onBeforeNavigate={onBeforeNavigate} />
        {lastOpen ? <SidebarSectionRule testID="sidebar-global-cards-end-rule" /> : null}
      </View>
    </GlobalCardLayoutContext.Provider>
  );
}

const styles = StyleSheet.create({
  stack: { flexShrink: 1, minHeight: 0 },
});
