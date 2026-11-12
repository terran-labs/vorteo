import { matchPanes, settingsLink, sectionForPath } from "./navigation-model";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { useRouter, type Href } from "expo-router";
import { isWeb } from "@/constants/platform";
import type { SettingsView } from "@/navigation/settings-navigation";
import { providerRowAnchorId } from "./settings-focus";
import { SYSTEM_HEALTH_ANCHOR_ID, type SettingsJumpTarget } from "./settings-jump";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { getPane, resolveSettingsTarget, type SettingsSectionId } from "@/settings-catalog/catalog";
import { searchSettings } from "@/settings-catalog/search";
import type {
  ResolvedSettingsEntry,
  SettingsPageSection,
  SettingsScrollRequest,
  SettingsSearchControls,
} from "./settings-scroll-page";

/** `/settings/<section>` and deeper, as opposed to the settings list at `/settings`. */
const SECTION_ADDRESS = /^\/settings\/[^/]+/;

/** Results the arrow keys can reach; matches the result list's length. */
const KEYBOARD_RESULTS = 8;

let requestNonce = 0;

function scrollRequest(
  section: SettingsSectionId,
  pane: string | null,
  entry: ResolvedSettingsEntry | null,
  animated: boolean,
  anchorId: string | null = null,
  focus = false,
): SettingsScrollRequest {
  requestNonce += 1;
  return {
    section,
    pane,
    entry,
    animated,
    anchorId,
    focus,
    nonce: requestNonce,
    issuedAt: Date.now(),
  };
}

/** The row a deep link scrolls to inside its pane, when it names one. */
function focusAnchorId(view: SettingsView, pane: string | null): string | null {
  // The health address comes from "System needs attention", which lands on the list itself.
  if (pane === "system.health") return SYSTEM_HEALTH_ANCHOR_ID;
  if (view.kind !== "section" || view.focus?.kind !== "provider") return null;
  return providerRowAnchorId(view.focus.providerType);
}

/** A pane id, or an older address that now opens a pane, such as `maintenance.updates`. */
function resolvePaneTarget(paneId: string): { section: SettingsSectionId; pane: string } | null {
  const pane = getPane(paneId);
  if (pane) return { section: pane.section, pane: pane.id };
  const target = resolveSettingsTarget(paneId);
  return target.pane ? { section: target.section, pane: target.pane } : null;
}

/**
 * Keeps a target's pane only when this device renders it. A desktop-only pane opened from a
 * browser would never report layout, leaving the jump armed and the page where it was; its
 * section is the closest place that exists.
 */
function availableTarget<T extends { section: SettingsSectionId; pane: string | null }>(
  target: T,
  sections: readonly SettingsPageSection[],
): T | { section: SettingsSectionId; pane: null } {
  if (!target.pane) return target;
  const rendered = sections.some((section) =>
    section.panes.some((pane) => pane.id === target.pane),
  );
  return rendered ? target : { section: target.section, pane: null };
}

interface SettingsNavigationInput {
  view: SettingsView;
  installationRequested: boolean;
  restartRequestId?: string | null;
  settingId: string | null;
  isCompactLayout: boolean;
  hasInstallation: boolean;
  sections: readonly SettingsPageSection[];
  entries: readonly ResolvedSettingsEntry[];
}

/**
 * Search, the section in view, and scroll requests for the settings page.
 * Sidebar choices scroll the continuous page on desktop and navigate on
 * compact layouts or from drill-in pages.
 */
export function useSettingsNavigation({
  view,
  installationRequested,
  restartRequestId = null,
  settingId,
  isCompactLayout,
  hasInstallation,
  sections,
  entries,
}: SettingsNavigationInput) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedResult, setSelectedResult] = useState(0);
  const results = useMemo(() => searchSettings(entries, query), [entries, query]);
  const matchedPanes = useMemo(() => matchPanes(sections, query), [sections, query]);

  const routeSection = view.kind === "section" ? view.section : null;
  const routeTarget = useMemo(() => {
    if (!routeSection) return null;
    // Existing restart links reveal their review in System; installation links keep owner controls.
    if (installationRequested && hasInstallation) {
      return {
        section: "system" as const,
        pane: restartRequestId ? "system.overview" : "maintenance.installation",
      };
    }
    return availableTarget(resolveSettingsTarget(routeSection), sections);
  }, [hasInstallation, installationRequested, restartRequestId, routeSection, sections]);
  const routeEntry = useMemo(
    () => (settingId ? (entries.find((entry) => entry.id === settingId) ?? null) : null),
    [entries, settingId],
  );
  const routeAnchorId = focusAnchorId(view, routeTarget?.pane ?? null);
  const routeFocus = routeTarget?.pane === "system.health";
  const [request, setRequest] = useState<SettingsScrollRequest>(() =>
    scrollRequest(
      routeTarget?.section ?? "general",
      routeTarget?.pane ?? null,
      null,
      false,
      routeAnchorId,
      routeFocus,
    ),
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    routeTarget?.section ?? "general",
  );
  const routeEntryId = routeEntry?.id ?? null;
  useEffect(() => {
    if (!routeTarget) return;
    setRequest(
      scrollRequest(
        routeEntry?.section ?? routeTarget.section,
        routeEntry?.pane ?? routeTarget.pane,
        routeEntry,
        false,
        routeAnchorId,
        routeFocus,
      ),
    );
    // A new entries array for the same entry, or new sections for the same target, must not
    // repeat the jump. A pane that becomes available, such as once hosts load, does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeTarget?.section, routeTarget?.pane, routeEntryId, routeAnchorId, routeFocus]);

  const handleActiveSectionChange = useCallback(
    (section: SettingsSectionId) => {
      setActiveSection(section);
      // Keep the address on the section being read, so a reload or a copied
      // link returns here, without adding a history entry per section.
      if (isWeb && view.kind === "section" && typeof window !== "undefined") {
        const path = window.location.pathname;
        // Only a section address belongs to this page. A compact section page that is opening
        // or being popped can report its top section while the address is still the settings
        // list's; rewriting it then leaves Back on the list under a section address.
        if (!SECTION_ADDRESS.test(path)) return;
        // An address that already opens this section keeps its precision, such
        // as /settings/connections landing on the Connections pane.
        if (sectionForPath(path) !== section) {
          window.history.replaceState(window.history.state, "", buildSettingsSectionRoute(section));
        }
      }
    },
    [view.kind],
  );

  const handleChangeQuery = useCallback((next: string) => {
    setQuery(next);
    setSelectedResult(0);
  }, []);

  const navigateTo = useCallback(
    (href: Href) => {
      if (isCompactLayout) router.push(href);
      else router.replace(href);
    },
    [isCompactLayout, router],
  );

  const handleSelectSection = useCallback(
    (section: SettingsSectionId) => {
      setQuery("");
      if (view.kind === "section" && !isCompactLayout) {
        setActiveSection(section);
        // Focus follows the jump, so keyboard and screen reader users land on the section.
        setRequest(scrollRequest(section, null, null, true, null, true));
        return;
      }
      navigateTo(settingsLink(section));
    },
    [isCompactLayout, navigateTo, view.kind],
  );

  const handleSelectResult = useCallback(
    (entry: ResolvedSettingsEntry) => {
      setQuery("");
      setSelectedResult(0);
      if (view.kind === "section") {
        setRequest(scrollRequest(entry.section, entry.pane, entry, false, null, true));
        return;
      }
      navigateTo(settingsLink(entry.section, entry.id));
    },
    [navigateTo, view.kind],
  );

  /**
   * Scrolls to a pane, or to one row in it, from inside the page or from a control outside it,
   * such as a health row's Fix or the sidebar's "System needs attention". Clears a search first,
   * which would otherwise hide the target.
   */
  const jumpTo = useCallback(
    (target: SettingsJumpTarget) => {
      const resolved = resolvePaneTarget(target.pane);
      if (!resolved) return;
      const pane = availableTarget(resolved, sections);
      const entry = target.settingId
        ? (entries.find((candidate) => candidate.id === target.settingId) ?? null)
        : null;
      setQuery("");
      setActiveSection(entry?.section ?? pane.section);
      setRequest(
        scrollRequest(
          entry?.section ?? pane.section,
          entry?.pane ?? pane.pane ?? null,
          entry,
          true,
          target.anchorId ?? null,
          // A jump the reader chose moves focus with it.
          target.focus ?? true,
        ),
      );
    },
    [entries, sections],
  );

  /** Scrolls to a pane from inside the page. */
  const openPane = useCallback((paneId: string) => jumpTo({ pane: paneId }), [jumpTo]);

  const handleSearchKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent.key;
      const last = Math.min(results.length, KEYBOARD_RESULTS) - 1;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault?.();
        setSelectedResult((index) =>
          key === "ArrowDown" ? Math.min(last, index + 1) : Math.max(0, index - 1),
        );
      } else if (key === "Escape") {
        setQuery("");
      }
    },
    [results.length],
  );

  const handleSearchSubmit = useCallback(() => {
    const result = results[selectedResult] ?? results[0];
    if (result) handleSelectResult(result.entry);
  }, [handleSelectResult, results, selectedResult]);

  const search = useMemo<SettingsSearchControls>(
    () => ({
      query,
      onChangeQuery: handleChangeQuery,
      onKeyPress: handleSearchKeyPress,
      onSubmit: handleSearchSubmit,
      resultsShown: query.trim().length > 0 && results.length > 0,
      activeResultId:
        (results[Math.min(selectedResult, KEYBOARD_RESULTS - 1)] ?? results[0])?.entry.id ?? null,
    }),
    [handleChangeQuery, handleSearchKeyPress, handleSearchSubmit, query, results, selectedResult],
  );

  return {
    query,
    search,
    results,
    matchedPanes,
    selectedResult,
    request,
    activeSection,
    handleActiveSectionChange,
    handleSelectSection,
    handleSelectResult,
    openPane,
    jumpTo,
  };
}
