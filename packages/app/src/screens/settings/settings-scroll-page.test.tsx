import { expect, it, vi } from "vitest";
const refs = vi.hoisted(() => [] as { current: unknown }[]);
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => {
    const ref = { current };
    refs.push(ref);
    return ref;
  },
  useState: (initial: unknown) => {
    if (typeof initial === "function") return [initial(), vi.fn()];
    return [initial === 0 ? 600 : initial, vi.fn()];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
}));
vi.mock("react-native", () => ({ Text: "text", View: "view", Pressable: "button" }));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("@/constants/platform", () => ({ isWeb: false }));
vi.mock("@/components/ui/scroll-view", () => ({ ScrollView: "scroll" }));
vi.mock("@/components/ui/highlighted-text", () => ({ HighlightedText: "text" }));
vi.mock("@/components/ui/search-field", () => ({ SearchField: "input" }));
vi.mock("@/settings-catalog/row-highlight", () => ({ settingsPaneDomId: (id: string) => id }));
import { SettingsScrollPage } from "./settings-scroll-page";
it("jumps once and leaves later layout changes to native anchoring", () => {
  const scrollTo = vi.fn();
  const page = SettingsScrollPage({
    sections: [{ id: "general", label: "General", panes: [] }],
    renderPane: () => null,
    request: { section: "general", pane: null, entry: null, animated: false, nonce: 1 },
    onActiveSectionChange: vi.fn(),
    query: "",
    results: [],
    matchedPanes: new Set(),
    selectedResult: 0,
    onSelectResult: vi.fn(),
  });
  refs[0].current = { scrollTo };
  const section = page.props.children[2][0];
  section.props.onSectionLayout("general", { y: 200, height: 300 });
  section.props.onSectionLayout("general", { y: 400, height: 500 });
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 184, animated: false });
  expect(page.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  expect(page.props.contentContainerStyle.paddingBottom).toBe(600);
});
