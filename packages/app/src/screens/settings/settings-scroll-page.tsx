import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Pressable,
  Text,
  View,
  type TextInputKeyPressEventData,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView as NativeScrollView,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { hoverStyle } from "@/styles/hover";
import { ScrollView } from "@/components/ui/scroll-view";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { SearchField } from "@/components/ui/search-field";
import { isWeb } from "@/constants/platform";
import type {
  SettingScope,
  SettingsPaneDefinition,
  SettingsSectionId,
} from "@/settings-catalog/catalog";
import type { SettingsSearchResult } from "@/settings-catalog/search";
import {
  findSettingRow,
  flashSettingRow,
  markSettingRows,
  rowOffsetWithin,
  settingsPaneDomId,
} from "@/settings-catalog/row-highlight";

export interface SettingsPageSection {
  id: SettingsSectionId;
  label: string;
  panes: SettingsPaneDefinition[];
}

export interface ResolvedSettingsEntry {
  id: string;
  pane: string;
  section: SettingsSectionId;
  label: string;
  hint?: string;
  keywords?: readonly string[];
  context: readonly string[];
  scope: SettingScope;
  /** Pane and section titles shown under a search result. */
  breadcrumb: string;
}

/** A request to bring a section, pane or row into view. A new nonce repeats it. */
export interface SettingsScrollRequest {
  section: SettingsSectionId;
  pane: string | null;
  entry: ResolvedSettingsEntry | null;
  animated: boolean;
  /** A row's DOM id inside the pane, for items a deep link opens in place. Web only. */
  anchorId?: string | null;
  nonce: number;
}

interface SettingsScrollPageProps {
  sections: readonly SettingsPageSection[];
  renderPane: (paneId: string) => ReactNode;
  request: SettingsScrollRequest;
  onActiveSectionChange: (section: SettingsSectionId) => void;
  query: string;
  results: readonly SettingsSearchResult<ResolvedSettingsEntry>[];
  /** Panes that match the query by title even without a matching row. */
  matchedPanes: ReadonlySet<string>;
  selectedResult: number;
  onSelectResult: (entry: ResolvedSettingsEntry) => void;
  /** Shows the search field above the sections, for compact layouts. */
  search?: SettingsSearchControls;
  bottomInset?: number;
}

const SCOPE_LABELS: Record<SettingScope, string> = {
  device: "This device",
  installation: "All environments",
  environment: "Per environment",
};

/** Where the active section changes, measured from the top of the scroll view. */
const SPY_OFFSET = 32;
/** Space kept above a section, pane or row after a jump. */
const JUMP_INSET = 16;
/** A programmatic scroll is over once no scroll event arrives for this long. */
const SCROLL_SETTLE_MS = 150;
const MAX_RESULTS_SHOWN = 8;
const ROW_WAIT_MS = 3000;

export interface SettingsSearchControls {
  query: string;
  onChangeQuery: (query: string) => void;
  onKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  onSubmit: () => void;
}

export function SettingsSearchBox({ search }: { search: SettingsSearchControls }) {
  return (
    <SearchField
      value={search.query}
      onChangeText={search.onChangeQuery}
      onKeyPress={search.onKeyPress}
      onSubmitEditing={search.onSubmit}
      placeholder="Search settings"
      clearAccessibilityLabel="Clear settings search"
      testID="settings-search-input"
      clearTestID="settings-search-clear"
    />
  );
}

function resultsSummary(count: number, anyVisible: boolean, query: string): string {
  if (count > 0) return `${count} matching ${count === 1 ? "setting" : "settings"}`;
  if (anyVisible) return "No matching settings. Matching sections are shown below.";
  return `No settings match “${query.trim()}”`;
}

function sectionDomId(section: SettingsSectionId): string {
  return `settings-page-section-${section}`;
}

/** The row a request lands on inside its pane, on web, once it has rendered. */
function requestRow(target: SettingsScrollRequest): HTMLElement | null {
  if (target.anchorId) return document.getElementById(target.anchorId);
  return target.entry ? findSettingRow(target.entry.pane, target.entry.label) : null;
}

interface Box {
  y: number;
  height: number;
}

/**
 * Every settings section in one scrolling column. The sidebar follows the
 * section in view, jumps scroll instead of navigating, and sections below the
 * target mount progressively so the first one appears without waiting on all.
 *
 * Native scroll anchoring preserves the reader's position as content loads.
 */
export function SettingsScrollPage({
  sections,
  renderPane,
  request,
  onActiveSectionChange,
  query,
  results,
  matchedPanes,
  selectedResult,
  onSelectResult,
  search,
  bottomInset = 0,
}: SettingsScrollPageProps) {
  const scrollRef = useRef<NativeScrollView>(null);
  const scrollY = useRef(0);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const sectionBoxes = useRef(new Map<SettingsSectionId, Box>());
  const paneBoxes = useRef(new Map<string, Box>());
  const programmatic = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<SettingsScrollRequest | null>(request);
  const paneArrival = useRef<SettingsScrollRequest | null>(null);
  const activeSection = useRef<SettingsSectionId | null>(null);
  const [viewport, setViewport] = useState(0);
  const searching = query.trim().length > 0;
  const previousSearch = useRef(searching);
  const waitingForLayout = useRef(false);
  const rowDeadline = useRef(Date.now() + ROW_WAIT_MS);
  const browserAnchoring = useRef(true);
  const previousRequest = useRef(request);
  // Invalidate before child layout callbacks run. A query clear and navigation request
  // can share one render, so retain the request and wait for restored measurements.
  if (previousSearch.current !== searching) {
    previousSearch.current = searching;
    sectionBoxes.current.clear();
    paneBoxes.current.clear();
    activeSection.current = null;
    waitingForLayout.current = true;
  }
  if (previousRequest.current !== request) {
    previousRequest.current = request;
    pending.current = request;
    rowDeadline.current = Date.now() + ROW_WAIT_MS;
  }

  const targetIndex = Math.max(
    0,
    sections.findIndex((section) => section.id === request.section),
  );
  // Sections up to the target mount at once so its position is real; the rest
  // follow one per frame.
  const [mountedCount, setMountedCount] = useState(() =>
    Math.min(sections.length, targetIndex + 2),
  );
  const visibleMounted = searching ? sections.length : mountedCount;

  useEffect(() => {
    if (mountedCount >= sections.length) return;
    const handle = setTimeout(() => setMountedCount((count) => count + 1), 16);
    return () => clearTimeout(handle);
  }, [mountedCount, sections.length]);

  useEffect(() => {
    if (targetIndex + 1 > mountedCount) setMountedCount(targetIndex + 2);
  }, [mountedCount, targetIndex]);

  // Let the browser preserve the reader's position as content loads.
  useEffect(() => {
    if (!isWeb) return;
    const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
    browserAnchoring.current =
      typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto");
    if (node && browserAnchoring.current) node.style.overflowAnchor = "auto";
  }, []);

  const markProgrammatic = useCallback(() => {
    programmatic.current = true;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      programmatic.current = false;
    }, SCROLL_SETTLE_MS);
  }, []);

  const scrollTo = useCallback(
    (y: number, animated: boolean) => {
      markProgrammatic();
      scrollRef.current?.scrollTo({ y: Math.max(0, y), animated });
    },
    [markProgrammatic],
  );

  const reportActive = useCallback(
    (section: SettingsSectionId) => {
      if (activeSection.current === section) return;
      activeSection.current = section;
      // The jump inset can leave the preceding section visible. Do not let the browser
      // anchor one of its loading rows and push the section the reader actually opened.
      if (isWeb) {
        for (const candidate of sections) {
          const element = document.getElementById(sectionDomId(candidate.id));
          if (element) element.style.overflowAnchor = candidate.id === section ? "auto" : "none";
        }
      }
      onActiveSectionChange(section);
    },
    [onActiveSectionChange, sections],
  );

  /**
   * Where a request's target sits in the scroll content, or null until it has
   * rendered. Web measures the DOM, which stays correct after a search hides
   * and restores sections; native uses the recorded layout boxes.
   */
  const targetOffset = useCallback(
    (target: SettingsScrollRequest): { y: number; row: HTMLElement | null } | null => {
      if (isWeb) {
        const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
        const element = document.getElementById(
          target.pane ? settingsPaneDomId(target.pane) : sectionDomId(target.section),
        );
        if (!node || !element || element.offsetHeight === 0) return null;
        const row = requestRow(target);
        // Loading-only panes are not useful destinations yet.
        if (!row && target.pane && element.querySelector('[data-settings-loading="true"]'))
          return null;
        const inset = row ? JUMP_INSET * 4 : JUMP_INSET;
        return { y: rowOffsetWithin(row ?? element, node) - inset, row };
      }
      const sectionBox = sectionBoxes.current.get(target.section);
      if (!sectionBox) return null;
      const paneBox = target.pane ? paneBoxes.current.get(target.pane) : undefined;
      if (target.pane && !paneBox) return null;
      return { y: sectionBox.y + (paneBox?.y ?? 0) - JUMP_INSET, row: null };
    },
    [],
  );

  /** Brings the pending request into view once its target has rendered. */
  const resolvePending = useCallback(() => {
    const next = pending.current;
    if (!next || searching || waitingForLayout.current) return;
    if (!sectionBoxes.current.has(next.section)) return;
    if (next.pane && !paneBoxes.current.has(next.pane)) return;
    const offset = targetOffset(next);
    if (!offset) return;
    const awaitingRow = isWeb && Boolean(next.anchorId || next.entry) && !offset.row;
    if (!awaitingRow || Date.now() >= rowDeadline.current) pending.current = null;
    // Show a ready pane immediately, then refine once if its row arrives. Layout events
    // while waiting must not repeatedly pull the reader back to the pane top.
    if (awaitingRow && paneArrival.current === next) return;
    paneArrival.current = next;
    reportActive(next.section);
    scrollTo(offset.y, next.animated);
    if (offset.row) flashSettingRow(offset.row);
  }, [reportActive, scrollTo, targetOffset, searching]);

  useEffect(() => {
    resolvePending();
    const timer = setTimeout(
      () => {
        resolvePending();
        // A missing pane must not leave a row request armed indefinitely.
        if (pending.current === request && (request.anchorId || request.entry))
          pending.current = null;
      },
      Math.max(0, rowDeadline.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [request, resolvePending]);

  // A reader gesture cancels a delayed row jump, rather than pulling them back later.
  useEffect(() => {
    if (!isWeb) return;
    const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
    const cancel = () => {
      pending.current = null;
    };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    events.forEach((name) => node?.addEventListener(name, cancel, { passive: true }));
    return () => events.forEach((name) => node?.removeEventListener(name, cancel));
  }, []);

  const updateActive = useCallback(() => {
    if (programmatic.current || searching) return;
    const top = scrollY.current + SPY_OFFSET;
    const atEnd = scrollY.current + viewportHeight.current >= contentHeight.current - 2;
    const node = isWeb
      ? (scrollRef.current?.getScrollableNode() as HTMLElement | undefined)
      : undefined;
    let current: SettingsSectionId | null = null;
    for (const section of sections) {
      let y = sectionBoxes.current.get(section.id)?.y;
      // Web layout events miss position-only moves, so read the DOM.
      const element = node ? document.getElementById(sectionDomId(section.id)) : null;
      if (node && element) y = rowOffsetWithin(element, node);
      if (y === undefined) continue;
      if (atEnd || y <= top) current = section.id;
    }
    if (current) reportActive(current);
  }, [reportActive, searching, sections]);

  const cancelPending = useCallback(() => {
    pending.current = null;
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.current = event.nativeEvent.contentOffset.y;
      if (programmatic.current) markProgrammatic();
      updateActive();
    },
    [markProgrammatic, updateActive],
  );

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    viewportHeight.current = event.nativeEvent.layout.height;
    setViewport(event.nativeEvent.layout.height);
  }, []);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    contentHeight.current = height;
  }, []);

  const handleSectionLayout = useCallback(
    (id: SettingsSectionId, box: Box) => {
      if (previousSearch.current !== searching) return;
      const old = sectionBoxes.current.get(id);
      // WebKit without overflow-anchor needs only the height delta above the reader.
      // Native maintainVisibleContentPosition tracks whole sections, not rows within a pane.
      if (isWeb && !browserAnchoring.current && old && !searching && !pending.current) {
        const active = sectionBoxes.current.get(activeSection.current!);
        if (active && old.y < active.y && old.height !== box.height) {
          scrollY.current += box.height - old.height;
          scrollTo(scrollY.current, false);
        }
      }
      sectionBoxes.current.set(id, box);
      waitingForLayout.current = false;
      resolvePending();
    },
    [resolvePending, scrollTo, searching],
  );

  const handlePaneLayout = useCallback(
    (id: string, box: Box) => {
      if (previousSearch.current !== searching) return;
      paneBoxes.current.set(id, box);
      resolvePending();
    },
    [resolvePending, searching],
  );

  // Tint matching rows while a search is active, after the panes render.
  const matchKey = results.map((result) => result.entry.id).join("|");
  useLayoutEffect(() => {
    if (!searching || !isWeb) return;
    const matches = results.map((result) => result.entry);
    let cleanup = () => {};
    const handle = setTimeout(() => {
      cleanup = markSettingRows(matches);
    }, 0);
    return () => {
      clearTimeout(handle);
      cleanup();
    };
    // matchKey stands in for results, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, searching]);

  const resultPanes = useMemo(() => new Set(results.map((result) => result.entry.pane)), [results]);
  const paneVisible = useCallback(
    (pane: SettingsPaneDefinition) =>
      !searching || resultPanes.has(pane.id) || matchedPanes.has(pane.id),
    [matchedPanes, resultPanes, searching],
  );

  const trailingSpace = searching ? JUMP_INSET * 4 : viewport;
  const contentStyle = useMemo(
    () => ({ paddingBottom: trailingSpace + bottomInset }),
    [bottomInset, trailingSpace],
  );

  const shownResults = results.slice(0, MAX_RESULTS_SHOWN);
  const anyVisible = sections.some((section) => section.panes.some(paneVisible));

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={contentStyle}
      onScroll={handleScroll}
      onScrollBeginDrag={cancelPending}
      scrollEventThrottle={16}
      onLayout={handleViewportLayout}
      onContentSizeChange={handleContentSizeChange}
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={isWeb ? undefined : nativeVisiblePosition}
      automaticallyAdjustKeyboardInsets
      testID="settings-scroll-page"
    >
      {search ? (
        <View style={[styles.column, styles.compactSearch]}>
          <SettingsSearchBox search={search} />
        </View>
      ) : null}
      {searching ? (
        <View style={styles.column} testID="settings-search-results">
          <Text style={styles.resultsTitle}>
            {resultsSummary(results.length, anyVisible, query)}
          </Text>
          {shownResults.length ? (
            <View style={styles.resultsCard}>
              {shownResults.map((result, index) => (
                <SearchResultRow
                  key={result.entry.id}
                  result={result}
                  selected={index === selectedResult}
                  bordered={index > 0}
                  onSelect={onSelectResult}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {sections.slice(0, visibleMounted).map((section) => {
        const panes = section.panes.filter(paneVisible);
        const hidden = searching && panes.length === 0;
        return (
          <SectionBlock
            key={section.id}
            layoutEpoch={searching}
            section={section}
            hidden={hidden}
            panes={section.panes}
            paneVisible={paneVisible}
            renderPane={renderPane}
            onSectionLayout={handleSectionLayout}
            onPaneLayout={handlePaneLayout}
          />
        );
      })}
    </ScrollView>
  );
}

function SectionBlock({
  layoutEpoch,
  section,
  hidden,
  panes,
  paneVisible,
  renderPane,
  onSectionLayout,
  onPaneLayout,
}: {
  layoutEpoch: boolean;
  section: SettingsPageSection;
  hidden: boolean;
  panes: readonly SettingsPaneDefinition[];
  paneVisible: (pane: SettingsPaneDefinition) => boolean;
  renderPane: (paneId: string) => ReactNode;
  onSectionLayout: (id: SettingsSectionId, box: Box) => void;
  onPaneLayout: (id: string, box: Box) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      onSectionLayout(section.id, { y, height });
    },
    [onSectionLayout, section.id],
  );
  const layoutRef = useRef<View>(null);
  useLayoutEffect(() => {
    layoutRef.current?.measure((_x, y, _width, height) =>
      onSectionLayout(section.id, { y, height }),
    );
  }, [layoutEpoch, onSectionLayout, section.id]);
  // Hidden sections stay mounted so their state survives a search.
  const style = useMemo(() => [styles.column, styles.section, hidden && styles.hidden], [hidden]);
  return (
    <View
      ref={layoutRef}
      style={style}
      onLayout={handleLayout}
      testID={`settings-page-section-${section.id}`}
      nativeID={sectionDomId(section.id)}
    >
      <Text
        style={styles.sectionTitle}
        accessibilityRole="header"
        testID={`settings-section-title-${section.id}`}
      >
        {section.label}
      </Text>
      {panes.map((pane) => (
        <PaneBlock
          key={pane.id}
          layoutEpoch={layoutEpoch}
          pane={pane}
          hidden={!paneVisible(pane)}
          renderPane={renderPane}
          onPaneLayout={onPaneLayout}
        />
      ))}
    </View>
  );
}

function PaneBlock({
  layoutEpoch,
  pane,
  hidden,
  renderPane,
  onPaneLayout,
}: {
  layoutEpoch: boolean;
  pane: SettingsPaneDefinition;
  hidden: boolean;
  renderPane: (paneId: string) => ReactNode;
  onPaneLayout: (id: string, box: Box) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      onPaneLayout(pane.id, { y, height });
    },
    [onPaneLayout, pane.id],
  );
  const layoutRef = useRef<View>(null);
  useLayoutEffect(() => {
    layoutRef.current?.measure((_x, y, _width, height) => onPaneLayout(pane.id, { y, height }));
  }, [layoutEpoch, onPaneLayout, pane.id]);
  return (
    <View
      ref={layoutRef}
      nativeID={settingsPaneDomId(pane.id)}
      onLayout={handleLayout}
      style={hidden ? styles.hidden : undefined}
      testID={`settings-pane-${pane.id}`}
    >
      {renderPane(pane.id)}
    </View>
  );
}

function SearchResultRow({
  result,
  selected,
  bordered,
  onSelect,
}: {
  result: SettingsSearchResult<ResolvedSettingsEntry>;
  selected: boolean;
  bordered: boolean;
  onSelect: (entry: ResolvedSettingsEntry) => void;
}) {
  const handlePress = useCallback(() => onSelect(result.entry), [onSelect, result.entry]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.resultRow,
      bordered && styles.resultBorder,
      styles.resultHover,
      (selected || pressed) && styles.resultActive,
    ],
    [bordered, selected],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityHint={`Opens ${result.entry.breadcrumb}`}
      onPress={handlePress}
      style={rowStyle}
      testID={`settings-search-result-${result.entry.id}`}
    >
      <View style={styles.resultText}>
        <HighlightedText
          text={result.entry.label}
          ranges={result.labelRanges}
          style={styles.resultLabel}
          numberOfLines={1}
        />
        <Text style={styles.resultMeta} numberOfLines={1}>
          {result.entry.breadcrumb}
        </Text>
      </View>
      <Text style={styles.resultScope}>{SCOPE_LABELS[result.entry.scope]}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
  },
  section: {
    paddingTop: theme.spacing[6],
  },
  hidden: {
    display: "none",
  },
  compactSearch: {
    flexDirection: "row",
    paddingTop: theme.spacing[3],
  },
  sectionTitle: {
    // Line up with the pane titles, which sit inset from their cards.
    marginLeft: theme.spacing[1],
    marginBottom: theme.spacing[4],
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  resultsTitle: {
    marginTop: theme.spacing[6],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  resultsCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  resultBorder: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  resultActive: {
    backgroundColor: theme.colors.surface2,
  },
  resultHover: hoverStyle({ backgroundColor: theme.colors.surface2 }),
  resultText: {
    flex: 1,
    minWidth: 0,
  },
  resultLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  resultMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  resultScope: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

const nativeVisiblePosition = { minIndexForVisible: 0 };
