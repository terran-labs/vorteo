import { useCallback, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlobalOpenQuestionsCard } from "@/open-questions/global-card";
import { GlobalQuotaCard } from "@/provider-usage/global-quota-card";
import {
  GlobalCardLayoutContext,
  globalCardLayout,
  type GlobalCardKind,
} from "./global-card-shell";

/**
 * The global sections at the top of the sidebar footer block, inside the navigation card between
 * the workspace list and the footer rows. Each section hides itself, with its rule, while it has
 * nothing to show, so an idle installation keeps the full list.
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
  return (
    <GlobalCardLayoutContext.Provider value={layout}>
      <View style={styles.stack} testID="sidebar-global-cards">
        <GlobalOpenQuestionsCard onBeforeNavigate={onBeforeNavigate} />
        <GlobalQuotaCard />
      </View>
    </GlobalCardLayoutContext.Provider>
  );
}

const styles = StyleSheet.create({
  stack: { flexShrink: 0 },
});
