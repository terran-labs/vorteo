import { View } from "react-native";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSidebarListReach } from "./list-reach";

/** Rows of the sidebar footer block that follow the global sections, in display order. */
export type SidebarFooterRow = "demo" | "rows" | "identity";
const ROW_ORDER: readonly SidebarFooterRow[] = ["demo", "rows", "identity"];

interface FooterRules {
  sectionsShown: boolean;
  setSectionsShown: (shown: boolean) => void;
  visible: ReadonlySet<SidebarFooterRow>;
  setVisible: (row: SidebarFooterRow, visible: boolean) => void;
}

const FooterRulesContext = createContext<FooterRules | null>(null);

/**
 * Owns the rules between the footer block's sections and the rows below them. The sections draw
 * the rule after themselves only while their last section is open, so the first visible row below
 * them skips its own rule whenever any section is showing.
 */
export function SidebarFooterBlock({ children }: { children: ReactNode }) {
  const [sectionsShown, setSectionsShown] = useState(false);
  const [visible, setVisibleState] = useState<ReadonlySet<SidebarFooterRow>>(
    () => new Set(["identity"]),
  );
  const setVisible = useCallback((row: SidebarFooterRow, shown: boolean) => {
    setVisibleState((current) => {
      if (current.has(row) === shown) return current;
      const next = new Set(current);
      if (shown) next.add(row);
      else next.delete(row);
      return next;
    });
  }, []);
  const value = useMemo(
    () => ({ sectionsShown, setSectionsShown, visible, setVisible }),
    [sectionsShown, setVisible, visible],
  );
  return (
    <FooterRulesContext.Provider value={value}>
      <View style={footerContainerStyle}>{children}</View>
    </FooterRulesContext.Provider>
  );
}

/**
 * Registers `row` as rendering while `shown`, and returns whether it draws a rule above itself.
 * Outside a footer block, every row keeps its rule.
 */
export function useFooterLeadingRule(row: SidebarFooterRow, shown = true): boolean {
  const rules = useContext(FooterRulesContext);
  const listReaches = useSidebarListReach((state) => state.reaches);
  const setVisible = rules?.setVisible;
  useLayoutEffect(() => {
    if (!setVisible || row === "identity") return;
    setVisible(row, shown);
    return () => setVisible(row, false);
  }, [row, setVisible, shown]);
  if (!rules) return true;
  const first = ROW_ORDER.find((candidate) => rules.visible.has(candidate));
  if (row !== first) return true;
  // The block's top rule separates it from the list only where the list reaches it.
  return !rules.sectionsShown && listReaches;
}

/** The global sections report whether any of them is showing. */
export function useReportSectionsShown(): ((shown: boolean) => void) | null {
  return useContext(FooterRulesContext)?.setSectionsShown ?? null;
}

const footerContainerStyle = { flexShrink: 1, minHeight: 0 };
