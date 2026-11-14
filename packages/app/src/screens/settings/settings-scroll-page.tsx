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
import { FLOATING_PANEL_RADIUS, FLOATING_PANEL_CONTROL_HEIGHT } from "@/styles/floating-panel";
import { SearchField } from "@/components/ui/search-field";
import { isWeb } from "@/constants/platform";
import {
  SettingsRevealContext,
  type SettingsRevealState,
} from "@/components/settings/reveal-context";
import { SettingsRuleHeading } from "@/components/settings/headings/settings-rule-heading";
import {
  getSection,
  type SettingsGroupName,
  type SettingScope,
  type SettingsPaneDefinition,
  type SettingsSectionId,
} from "@/settings-catalog/catalog";
import type { SettingsSearchResult } from "@/settings-catalog/search";
import {
  findSettingRow,
  findSettingRowInDialogs,
  flashSettingRow,
  markSettingRows,
  rowOffsetWithin,
  settingsElementById,
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
  /** Moves keyboard focus to the target once it is in view, such as the System health list. */
  focus?: boolean;
  nonce: number;
  /** When the request was made; disclosures that mount much later ignore it. */
  issuedAt?: number;
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
  /** Translated name for a top-level group heading. Defaults to the catalog's English name. */
  groupLabel?: (group: SettingsGroupName) => string;
  /**
   * Panes that render another pane's rows, such as a section's shared Advanced group, and so
   * must stay visible when those rows match a search. Given the matching panes and entry ids.
   */
  searchHostPanes?: (panes: ReadonlySet<string>, entryIds: ReadonlySet<string>) => Set<string>;
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
/** Height of the desktop sidebar's Back button and search field, pointer layouts only. */
export const SIDEBAR_CONTROL_HEIGHT = 32;
const ROW_WAIT_MS = 3000;

export interface SettingsSearchControls {
  query: string;
  onChangeQuery: (query: string) => void;
  onKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  onSubmit: () => void;
  /** Whether the result list shows, for the field's combobox state. */
  resultsShown?: boolean;
  /** The highlighted result's catalog id; arrow keys move it while focus stays in the field. */
  activeResultId?: string | null;
}

/** The result list the search field controls. */
export const SETTINGS_RESULTS_LIST_ID = "settings-search-results-list";

/** A result option's DOM id, for the field's `aria-activedescendant`. */
export function settingsResultOptionId(entryId: string): string {
  return `settings-search-result-option-${entryId}`;
}

export function SettingsSearchBox({
  search,
  fitPlaceholder = false,
  compact = false,
}: {
  search: SettingsSearchControls;
  fitPlaceholder?: boolean;
  /** The desktop sidebar's shorter field, matching its Back button. */
  compact?: boolean;
}) {
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
      fitPlaceholder={fitPlaceholder}
      style={compact ? styles.compactSearchField : styles.searchField}
      // A combobox over the result list: arrows move the highlighted result while typing.
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={Boolean(search.resultsShown)}
      aria-controls={SETTINGS_RESULTS_LIST_ID}
      aria-activedescendant={
        search.resultsShown && search.activeResultId
          ? settingsResultOptionId(search.activeResultId)
          : undefined
      }
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
function requestRow(target: SettingsScrollRequest, root: HTMLElement): HTMLElement | null {
  if (target.anchorId) return settingsElementById(target.anchorId, root);
  if (!target.entry) return null;
  // A pane can reveal a row in a dialog it opens, such as an environment's Edit dialog.
  return (
    findSettingRow(target.entry.pane, target.entry.label, root) ??
    findSettingRowInDialogs(target.entry.label)
  );
}

/**
 * A pane whose controls render inside a sibling's shared Advanced group is empty; land on the
 * next pane that shows something, which holds the group.
 */
function renderedPane(element: HTMLElement | null): HTMLElement | null {
  let candidate = element;
  while (candidate && candidate.offsetHeight === 0 && candidate.id?.startsWith("settings-pane-")) {
    const next = candidate.nextElementSibling as HTMLElement | null;
    if (!next) break;
    candidate = next;
  }
  return candidate;
}

function sectionTitleDomId(section: SettingsSectionId): string {
  return `settings-section-title-${section}`;
}

// A row's own setting first, so focus does not land on an info tip or link beside the label.
const PRIMARY_CONTROL =
  'input, select, textarea, [role="switch"], [role="radio"], [role="combobox"], [role="checkbox"]';
const FOCUSABLE =
  'button, input, select, textarea, a[href], [role="switch"], [role="button"], [role="radio"], [tabindex="0"]';

/**
 * Where keyboard focus lands after a jump: a row's first control, a pane's first heading, or a
 * section's title, so screen reader and keyboard users arrive where the page scrolled.
 */
function focusElementFor(
  target: SettingsScrollRequest,
  offset: { row: HTMLElement | null; element: HTMLElement | null },
  node: HTMLElement,
): HTMLElement | null {
  if (offset.row) {
    // An anchor names a whole region, such as the health list; land on the region itself.
    if (target.anchorId) return offset.row;
    return (
      offset.row.querySelector<HTMLElement>(PRIMARY_CONTROL) ??
      offset.row.querySelector<HTMLElement>(FOCUSABLE) ??
      offset.row
    );
  }
  if (!target.pane) return settingsElementById(sectionTitleDomId(target.section), node);
  return offset.element?.querySelector<HTMLElement>('[role="heading"]') ?? offset.element;
}

/**
 * After the page scrolls: bring a row that sits in a dialog into view there, flash the row, and
 * move focus when the jump asks for it and is final.
 */
function markLanding(
  target: SettingsScrollRequest,
  offset: { row: HTMLElement | null; element: HTMLElement | null },
  node: HTMLElement | undefined,
  final: boolean,
) {
  if (offset.row && node && !inPage(node, offset.row))
    offset.row.scrollIntoView?.({ block: "center" });
  if (offset.row) flashSettingRow(offset.row);
  const focusable = target.focus && node ? focusElementFor(target, offset, node) : null;
  if (focusable && final) focusTarget(focusable);
}

/** Whether an element sits in this page's scroll content rather than in a dialog. */
function inPage(node: HTMLElement, element: HTMLElement): boolean {
  return typeof node.contains !== "function" || node.contains(element);
}

/** Hands keyboard focus to a jump's target without scrolling it again. */
function focusTarget(element: HTMLElement) {
  if (!element.hasAttribute?.("tabindex")) {
    // A heading or region made focusable only to receive the jump: it is not a control, so it
    // draws no focus ring (the row flash marks where the reader landed).
    element.setAttribute?.("tabindex", "-1");
    if (element.style) element.style.outline = "none";
  }
  element.focus?.({ preventScroll: true });
}

/** The scrolling element on web, where every DOM lookup for this page starts. */
function scrollNodeOf(view: NativeScrollView | null): HTMLElement | undefined {
  return isWeb ? (view?.getScrollableNode() as HTMLElement | undefined) : undefined;
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
  groupLabel = englishGroupLabel,
  searchHostPanes,
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
  // Null until the last section reports its height; until then a full viewport of space stays.
  const [lastSectionHeight, setLastSectionHeight] = useState<number | null>(null);
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
        const node = scrollNodeOf(scrollRef.current);
        for (const candidate of sections) {
          const element = settingsElementById(sectionDomId(candidate.id), node);
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
    (
      target: SettingsScrollRequest,
    ): { y: number; row: HTMLElement | null; element: HTMLElement | null } | null => {
      if (isWeb) {
        const node = scrollNodeOf(scrollRef.current);
        if (!node) return null;
        const element = renderedPane(
          settingsElementById(
            target.pane ? settingsPaneDomId(target.pane) : sectionDomId(target.section),
            node,
          ),
        );
        if (!element || element.offsetHeight === 0) return null;
        const row = requestRow(target, node);
        // Loading-only panes are not useful destinations yet.
        if (!row && target.pane && element.querySelector('[data-settings-loading="true"]'))
          return null;
        // A section's own top padding is its inset; panes and rows get room above them.
        let inset = target.pane ? JUMP_INSET : 0;
        // A row in a dialog scrolls within the dialog; the page stays on its pane.
        const pageRow = row && inPage(node, row) ? row : null;
        if (pageRow) inset = JUMP_INSET * 4;
        return { y: rowOffsetWithin(pageRow ?? element, node) - inset, row, element };
      }
      const sectionBox = sectionBoxes.current.get(target.section);
      if (!sectionBox) return null;
      const paneBox = target.pane ? paneBoxes.current.get(target.pane) : undefined;
      if (target.pane && !paneBox) return null;
      return { y: sectionBox.y + (paneBox ? paneBox.y - JUMP_INSET : 0), row: null, element: null };
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
    // Focus once the jump is final, not on the pane before its row arrives.
    markLanding(next, offset, scrollNodeOf(scrollRef.current), pending.current === null);
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
    const node = scrollNodeOf(scrollRef.current);
    let current: SettingsSectionId | null = null;
    for (const section of sections) {
      let y = sectionBoxes.current.get(section.id)?.y;
      // Web layout events miss position-only moves, so read the DOM.
      const element = node ? settingsElementById(sectionDomId(section.id), node) : null;
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
      if (id === sections[sections.length - 1]?.id) setLastSectionHeight(box.height);
      waitingForLayout.current = false;
      resolvePending();
    },
    [resolvePending, scrollTo, searching, sections],
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
      cleanup = markSettingRows(matches, scrollNodeOf(scrollRef.current));
    }, 0);
    return () => {
      clearTimeout(handle);
      cleanup();
    };
    // matchKey stands in for results, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, searching]);

  const resultPanes = useMemo(() => new Set(results.map((result) => result.entry.pane)), [results]);
  const hostPanes = useMemo(
    () =>
      searching && searchHostPanes
        ? searchHostPanes(resultPanes, new Set(results.map((result) => result.entry.id)))
        : NO_PANES,
    // matchKey stands in for results, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matchKey, resultPanes, searchHostPanes, searching],
  );
  const paneVisible = useCallback(
    (pane: SettingsPaneDefinition) =>
      !searching || resultPanes.has(pane.id) || matchedPanes.has(pane.id) || hostPanes.has(pane.id),
    [hostPanes, matchedPanes, resultPanes, searching],
  );

  // Room for the last section's heading to reach the top of the view, and no more: only what
  // the section itself falls short of a full viewport. A tall last section needs none.
  const trailingSpace = searching
    ? JUMP_INSET * 4
    : Math.max(0, viewport - (lastSectionHeight ?? 0));
  const contentStyle = useMemo(
    () => ({ paddingBottom: trailingSpace + bottomInset }),
    [bottomInset, trailingSpace],
  );

  // Each pane learns where jumps and searches point, so an Advanced group there can open.
  const searchPanes = useMemo(() => (searching ? resultPanes : NO_PANES), [resultPanes, searching]);
  const searchSettingIds = useMemo(
    () => (searching ? new Set(results.map((result) => result.entry.id)) : NO_PANES),
    // matchKey stands in for results, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matchKey, searching],
  );
  const revealFor = useCallback(
    (paneId: string): SettingsRevealState => ({
      pane: paneId,
      targetPane: request.pane,
      nonce: request.nonce,
      searchPanes,
      searchSettingIds,
      targetSettingId: request.entry?.id ?? null,
      issuedAt: request.issuedAt ?? 0,
    }),
    [request.entry, request.issuedAt, request.nonce, request.pane, searchPanes, searchSettingIds],
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
      {/* Mounted before the first search so its first message is announced. */}
      <Text accessibilityLiveRegion="polite" style={styles.visuallyHidden}>
        {searching ? resultsSummary(results.length, anyVisible, query) : ""}
      </Text>
      {searching ? (
        <View style={styles.column} testID="settings-search-results">
          <Text style={styles.resultsTitle}>
            {resultsSummary(results.length, anyVisible, query)}
          </Text>
          {shownResults.length ? (
            <View {...resultsListProps} style={styles.resultsCard}>
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
      {sections.slice(0, visibleMounted).map((section, index) => {
        const panes = section.panes.filter(paneVisible);
        const hidden = searching && panes.length === 0;
        const group = getSection(section.id).group;
        const startsGroup = index === 0 || getSection(sections[index - 1].id).group !== group;
        return (
          <SectionBlock
            key={section.id}
            layoutEpoch={searching}
            section={section}
            groupHeading={startsGroup ? groupLabel(group) : null}
            hidden={hidden}
            panes={section.panes}
            paneVisible={paneVisible}
            revealFor={revealFor}
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
  groupHeading,
  hidden,
  panes,
  paneVisible,
  revealFor,
  renderPane,
  onSectionLayout,
  onPaneLayout,
}: {
  layoutEpoch: boolean;
  section: SettingsPageSection;
  /** This device or Vorteo, above the first section of each group. */
  groupHeading: string | null;
  hidden: boolean;
  panes: readonly SettingsPaneDefinition[];
  paneVisible: (pane: SettingsPaneDefinition) => boolean;
  revealFor: (paneId: string) => SettingsRevealState;
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
      {groupHeading ? (
        <SettingsRuleHeading label={groupHeading} testID={`settings-group-heading-${section.id}`} />
      ) : null}
      <Text
        {...sectionHeadingLevel}
        style={styles.sectionTitle}
        accessibilityRole="header"
        numberOfLines={1}
        nativeID={sectionTitleDomId(section.id)}
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
          reveal={revealFor(pane.id)}
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
  reveal,
  renderPane,
  onPaneLayout,
}: {
  layoutEpoch: boolean;
  pane: SettingsPaneDefinition;
  hidden: boolean;
  reveal: SettingsRevealState;
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
  // A fresh object per render would re-render every pane's context consumers on each scroll.
  const revealValue = useMemo(
    () => ({
      pane: reveal.pane,
      targetPane: reveal.targetPane,
      nonce: reveal.nonce,
      searchPanes: reveal.searchPanes,
      searchSettingIds: reveal.searchSettingIds,
      targetSettingId: reveal.targetSettingId,
      issuedAt: reveal.issuedAt,
    }),
    [
      reveal.pane,
      reveal.targetPane,
      reveal.targetSettingId,
      reveal.issuedAt,
      reveal.nonce,
      reveal.searchPanes,
      reveal.searchSettingIds,
    ],
  );
  return (
    <View
      ref={layoutRef}
      nativeID={settingsPaneDomId(pane.id)}
      onLayout={handleLayout}
      style={hidden ? styles.hidden : undefined}
      testID={`settings-pane-${pane.id}`}
    >
      <SettingsRevealContext.Provider value={revealValue}>
        {renderPane(pane.id)}
      </SettingsRevealContext.Provider>
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
  // The arrow keys in the search field move the selection; `aria-selected` exposes it on web,
  // where `accessibilityState` is dropped.
  // An option of the field's listbox: highlighted by `aria-activedescendant` while focus stays
  // in the field, so the options themselves are not Tab stops.
  const webOption = useMemo(
    () =>
      isWeb
        ? ({
            role: "option",
            "aria-selected": selected,
            id: settingsResultOptionId(result.entry.id),
            tabIndex: -1,
          } as const)
        : null,
    [result.entry.id, selected],
  );
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
      {...webOption}
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
  searchField: { height: FLOATING_PANEL_CONTROL_HEIGHT, borderRadius: FLOATING_PANEL_RADIUS },
  compactSearchField: {
    flex: 1,
    height: SIDEBAR_CONTROL_HEIGHT,
    minHeight: SIDEBAR_CONTROL_HEIGHT,
    borderRadius: SIDEBAR_CONTROL_HEIGHT / 2,
  },
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
    marginBottom: theme.spacing[3],
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  // Read by screen readers, invisible on screen.
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    opacity: 0,
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
const NO_PANES: ReadonlySet<string> = new Set();
const englishGroupLabel = (group: SettingsGroupName) => group;
// React Native's Role type lacks "listbox"; react-native-web passes it through.
const resultsListProps: object = isWeb
  ? { role: "listbox", "aria-label": "Matching settings", id: SETTINGS_RESULTS_LIST_ID }
  : {};
// Group headings are level 2, so section titles sit one level under them.
const sectionHeadingLevel = isWeb ? ({ "aria-level": 3 } as const) : null;
