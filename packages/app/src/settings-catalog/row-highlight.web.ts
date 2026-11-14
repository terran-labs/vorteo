/**
 * Finds and marks a setting's row inside its pane on web. Panes reuse existing
 * settings components that know nothing about search, so the row is located
 * by its visible label rather than by an id threaded through every component.
 */

const ROW_MIN_WIDTH_RATIO = 0.9;
/** Settings rows are at least this tall; headings are a single short line. */
const ROW_MIN_HEIGHT = 36;
const MARK_ATTRIBUTE = "data-settings-search-match";

export function settingsPaneDomId(paneId: string): string {
  return `settings-pane-${paneId}`;
}

/**
 * The element with `id` inside `root`. A route pushed on top of an open settings page leaves the
 * page below mounted with the same ids, and `getElementById` returns the first one in the
 * document, so lookups for one page must stay inside that page's own scroll content.
 */
export function settingsElementById(id: string, root?: ParentNode | null): HTMLElement | null {
  const first = document.getElementById(id);
  if (!root || !first || typeof (root as Node).contains !== "function") return first;
  if ((root as Node).contains(first)) return first;
  return root.querySelector<HTMLElement>(`[id="${id}"]`);
}

function findLabelElements(pane: HTMLElement, label: string): HTMLElement[] {
  const wanted = label.trim().toLowerCase();
  const found: HTMLElement[] = [];
  const walker = pane.ownerDocument.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim().toLowerCase() === wanted && node.parentElement) {
      found.push(node.parentElement);
    }
  }
  return found;
}

/**
 * The row around a label: the first ancestor spanning nearly the pane's width.
 * The label's own column is narrower because the control sits beside it, and
 * the card around the row is the next full-width ancestor, so stopping at the
 * first one marks the row alone.
 */
function rowFor(element: HTMLElement, pane: HTMLElement): HTMLElement {
  const fullWidth = pane.getBoundingClientRect().width * ROW_MIN_WIDTH_RATIO;
  let row = element;
  while (row.parentElement && row !== pane) {
    if (row.getBoundingClientRect().width >= fullWidth) return row;
    row = row.parentElement;
  }
  return element;
}

/**
 * A pane heading can share a row's label ("Theme" above the Theme row), so
 * prefer a match whose row is control-height over a one-line heading.
 */
export function findSettingRow(
  paneId: string,
  label: string,
  root?: ParentNode | null,
): HTMLElement | null {
  const pane = settingsElementById(settingsPaneDomId(paneId), root);
  if (!pane) return null;
  // A section's single Advanced group can hold rows indexed under a sibling pane, so look in
  // the whole section when the pane itself has no such row.
  const section = pane.parentElement?.closest<HTMLElement>('[id^="settings-page-section-"]');
  for (const container of section ? [pane, section] : [pane]) {
    const rows = findLabelElements(container, label).map((element) => rowFor(element, container));
    const row = rows.find((candidate) => candidate.offsetHeight >= ROW_MIN_HEIGHT) ?? rows[0];
    if (row) return row;
  }
  return null;
}

/**
 * A row inside an open dialog, for settings that render in a dialog their pane opens, such as an
 * environment's Edit dialog. The newest dialog wins.
 */
export function findSettingRowInDialogs(label: string): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].toReversed();
  for (const dialog of dialogs) {
    const rows = findLabelElements(dialog, label).map((element) => rowFor(element, dialog));
    const row = rows.find((candidate) => candidate.offsetHeight >= ROW_MIN_HEIGHT) ?? rows[0];
    if (row) return row;
  }
  return null;
}

/**
 * A tint of the row's own text color, so the mark follows the active theme
 * without React reading the theme.
 */
function tintFor(row: HTMLElement, percent: number): string {
  const text = row.querySelector("[dir]") ?? row;
  const color = getComputedStyle(text).color || "currentColor";
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/** Briefly tints a row so the eye lands on it after a jump. */
export function flashSettingRow(row: HTMLElement): void {
  const color = tintFor(row, 16);
  row.animate(
    [{ backgroundColor: color }, { backgroundColor: color, offset: 0.6 }, { backgroundColor: "" }],
    { duration: 1600, easing: "ease-out" },
  );
}

/**
 * Tints every matching row while a search is active. Returns the cleanup that
 * restores the rows' own backgrounds.
 */
export function markSettingRows(
  matches: ReadonlyArray<{ pane: string; label: string }>,
  root?: ParentNode | null,
): () => void {
  const marked: Array<{ row: HTMLElement; background: string }> = [];
  for (const match of matches) {
    const row = findSettingRow(match.pane, match.label, root);
    if (!row || row.hasAttribute(MARK_ATTRIBUTE)) continue;
    marked.push({ row, background: row.style.backgroundColor });
    row.setAttribute(MARK_ATTRIBUTE, "");
    row.style.backgroundColor = tintFor(row, 8);
  }
  return () => {
    for (const { row, background } of marked) {
      row.removeAttribute(MARK_ATTRIBUTE);
      row.style.backgroundColor = background;
    }
  };
}

/** Position of `row` within the scroll container's content. */
export function rowOffsetWithin(row: HTMLElement, scrollNode: HTMLElement): number {
  return (
    row.getBoundingClientRect().top - scrollNode.getBoundingClientRect().top + scrollNode.scrollTop
  );
}
