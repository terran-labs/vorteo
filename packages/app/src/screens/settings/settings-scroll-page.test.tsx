import { beforeEach, afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  web: false,
  row: null as unknown,
  skeleton: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => {
    const index = hooks.cursor++;
    hooks.refs[index] ??= { current };
    return hooks.refs[index];
  },
  useState: (initial: unknown) => {
    if (typeof initial === "function") return [initial(), vi.fn()];
    return [initial === 0 ? 600 : initial, vi.fn()];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => {
    hooks.effects.push(fn);
  },
  useLayoutEffect: (fn: () => unknown) => {
    hooks.effects.push(fn);
  },
}));
vi.mock("react-native", () => ({ Text: "text", View: "view", Pressable: "button" }));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return hooks.web;
  },
}));
vi.mock("@/components/ui/scroll-view", () => ({ ScrollView: "scroll" }));
vi.mock("@/components/ui/highlighted-text", () => ({ HighlightedText: "text" }));
vi.mock("@/components/ui/search-field", () => ({ SearchField: "input" }));
vi.mock("@/settings-catalog/row-highlight", () => ({
  settingsPaneDomId: (id: string) => id,
  settingsElementById: (id: string) => document.getElementById(id),
  findSettingRow: () => hooks.row,
  findSettingRowInDialogs: () => null,
  flashSettingRow: vi.fn(),
  rowOffsetWithin: (element: { y: number }) => element.y,
  markSettingRows: () => () => {},
}));
import {
  SettingsScrollPage,
  type ResolvedSettingsEntry,
  type SettingsPageSection,
} from "./settings-scroll-page";
import { flashSettingRow } from "@/settings-catalog/row-highlight";
const entry = {
  id: "row",
  section: "general",
  pane: "general.test",
  label: "Test",
} as ResolvedSettingsEntry;
function props() {
  const sections: SettingsPageSection[] = [{ id: "general", label: "General", panes: [] }];
  return {
    sections,
    renderPane: () => null,
    request: {
      section: "general" as const,
      pane: null as string | null,
      entry: null as ResolvedSettingsEntry | null,
      animated: false,
      nonce: 1,
    },
    onActiveSectionChange: vi.fn(),
    query: "",
    results: [],
    matchedPanes: new Set<string>(),
    selectedResult: 0,
    onSelectResult: vi.fn(),
  };
}
function render(input: ReturnType<typeof props>) {
  hooks.cursor = 0;
  hooks.effects = [];
  const page = SettingsScrollPage(input);
  hooks.effects.forEach((effect) => effect());
  return { page, section: page.props.children[3][0] };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hooks.refs = [];
  hooks.web = false;
  hooks.row = null;
  hooks.skeleton = false;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("jumps once and leaves later layout changes to native anchoring", () => {
  const scrollTo = vi.fn();
  const { page, section } = render(props());
  hooks.refs[0].current = { scrollTo };
  section.props.onSectionLayout("general", { y: 200, height: 300 });
  section.props.onSectionLayout("general", { y: 400, height: 500 });
  // A section jump lands on the section's top; its own padding is the inset.
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 200, animated: false });
  expect(page.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  expect(page.props.contentContainerStyle.paddingBottom).toBe(600);
});
it("preserves a search-result request submitted with a query clear until restored native layout", () => {
  const input = props();
  input.query = "test";
  const scrollTo = vi.fn();
  const first = render(input);
  hooks.refs[0].current = { scrollTo };
  first.section.props.onSectionLayout("general", { y: 800, height: 300 });
  first.section.props.onPaneLayout("general.test", { y: 100, height: 100 });
  input.onSelectResult.mockImplementation(() => {
    input.query = "";
    input.request = { ...input.request, pane: entry.pane, entry, nonce: 2 };
  });
  input.onSelectResult(entry);
  const restored = render(input);
  expect(scrollTo).not.toHaveBeenCalled();
  restored.section.props.onSectionLayout("general", { y: 200, height: 300 });
  expect(scrollTo).not.toHaveBeenCalled();
  restored.section.props.onPaneLayout("general.test", { y: 50, height: 100 });
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 234, animated: false });
  expect(first.page.props.contentContainerStyle.paddingBottom).toBe(64);
});
it.each([false, true])(
  "shows a ready pane immediately and refines once, but waits for skeletons (%s)",
  (skeleton) => {
    hooks.skeleton = skeleton;
    hooks.web = true;
    vi.stubGlobal("CSS", { supports: () => true });
    vi.stubGlobal("document", {
      getElementById: () => ({
        offsetHeight: 100,
        y: 200,
        style: {},
        querySelector: () => hooks.skeleton,
      }),
    });
    const input = props();
    input.request = { ...input.request, pane: entry.pane, entry };
    const { section } = render(input);
    const scrollTo = vi.fn();
    hooks.refs[0].current = { scrollTo, getScrollableNode: () => ({}) };
    section.props.onSectionLayout("general", { y: 200, height: 300 });
    section.props.onPaneLayout(entry.pane, { y: 0, height: 100 });
    expect(scrollTo).toHaveBeenCalledTimes(skeleton ? 0 : 1);
    if (!skeleton) expect(scrollTo).toHaveBeenLastCalledWith({ y: 184, animated: false });
    section.props.onPaneLayout(entry.pane, { y: 0, height: 150 });
    expect(scrollTo).toHaveBeenCalledTimes(skeleton ? 0 : 1);
    hooks.skeleton = false;
    hooks.row = { y: 400 };
    section.props.onPaneLayout(entry.pane, { y: 0, height: 200 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 336, animated: false });
    expect(flashSettingRow).toHaveBeenCalledTimes(1);
    section.props.onPaneLayout(entry.pane, { y: 0, height: 300 });
    expect(scrollTo).toHaveBeenCalledTimes(skeleton ? 1 : 2);
  },
);

it("does not revive a completed request when Escape clears search", () => {
  const input = props();
  const scrollTo = vi.fn();
  const initial = render(input);
  hooks.refs[0].current = { scrollTo };
  initial.section.props.onSectionLayout("general", { y: 200, height: 300 });
  input.query = "test";
  render(input);
  input.query = "";
  const restored = render(input);
  restored.section.props.onSectionLayout("general", { y: 200, height: 300 });
  expect(scrollTo).toHaveBeenCalledTimes(1);
});
it.each([true, false])(
  "compensates above the active section only without browser anchoring (%s)",
  (supported) => {
    hooks.web = true;
    vi.stubGlobal("CSS", { supports: () => supported });
    vi.stubGlobal("document", {
      getElementById: () => ({
        offsetHeight: 100,
        y: 200,
        style: {},
        querySelector: () => hooks.skeleton,
      }),
    });
    const input = props();
    const { page, section } = render(input);
    const scrollTo = vi.fn();
    hooks.refs[0].current = { scrollTo, getScrollableNode: () => ({}) };
    section.props.onSectionLayout("providers", { y: 0, height: 100 });
    section.props.onSectionLayout("general", { y: 200, height: 300 });
    page.props.onScroll({ nativeEvent: { contentOffset: { y: 184 } } });
    scrollTo.mockClear();
    section.props.onSectionLayout("providers", { y: 0, height: 150 });
    expect(scrollTo).toHaveBeenCalledTimes(supported ? 0 : 1);
    if (!supported) expect(scrollTo).toHaveBeenLastCalledWith({ y: 234, animated: false });
    section.props.onSectionLayout("general", { y: 250, height: 350 });
    expect(scrollTo).toHaveBeenCalledTimes(supported ? 0 : 1);
  },
);
it.each([false, true])("bounds delayed row jumps and respects reader gestures (%s)", (cancel) => {
  hooks.web = true;
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("document", {
    getElementById: () => ({
      offsetHeight: 100,
      y: 200,
      style: {},
      querySelector: () => hooks.skeleton,
    }),
  });
  const input = props();
  input.request = { ...input.request, pane: entry.pane, entry };
  const { page, section } = render(input);
  const scrollTo = vi.fn();
  hooks.refs[0].current = { scrollTo, getScrollableNode: () => ({}) };
  section.props.onSectionLayout("general", { y: 200, height: 300 });
  section.props.onPaneLayout(entry.pane, { y: 0, height: 100 });
  if (cancel) page.props.onScrollBeginDrag();
  vi.advanceTimersByTime(3000);
  expect(scrollTo).toHaveBeenCalledTimes(1);
  hooks.row = { y: 400 };
  section.props.onPaneLayout(entry.pane, { y: 0, height: 200 });
  expect(scrollTo).toHaveBeenCalledTimes(1);
});

it("expires a row request even when its pane never reports layout", () => {
  const input = props();
  input.request = { ...input.request, pane: entry.pane, entry };
  const { section } = render(input);
  const scrollTo = vi.fn();
  hooks.refs[0].current = { scrollTo };
  vi.advanceTimersByTime(3000);
  section.props.onSectionLayout("general", { y: 200, height: 300 });
  section.props.onPaneLayout(entry.pane, { y: 0, height: 100 });
  expect(scrollTo).not.toHaveBeenCalled();
});

it("excludes neighboring sections from browser anchoring after a jump", () => {
  hooks.web = true;
  vi.stubGlobal("CSS", { supports: () => true });
  const general = {
    offsetHeight: 100,
    y: 200,
    style: { overflowAnchor: "" },
    querySelector: () => false,
  };
  const accounts = {
    offsetHeight: 100,
    y: 400,
    style: { overflowAnchor: "" },
    querySelector: () => false,
  };
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id.endsWith("providers") ? accounts : general),
  });
  const input = props();
  input.sections.push({ id: "providers", label: "Accounts", panes: [] });
  const { section } = render(input);
  hooks.refs[0].current = { scrollTo: vi.fn(), getScrollableNode: () => ({}) };
  section.props.onSectionLayout("general", { y: 200, height: 100 });
  expect(general.style.overflowAnchor).toBe("auto");
  expect(accounts.style.overflowAnchor).toBe("none");
});
