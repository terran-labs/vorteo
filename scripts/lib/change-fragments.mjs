// Change fragments (docs/release.md, "Change fragments"). Every ordinary commit adds its
// release notes and inventory review as a new file, changes/YYYY-MM-DD-<slug>.md, instead of
// editing the top of VORTEO_CHANGELOG.md and docs/vorteo-customizations.md, so concurrent
// branches never conflict there. Release preparation folds every fragment into the new
// version's changelog entry and the inventory, then deletes them.
//
// A fragment is changelog bullets under optional `###` category headings, then one
// `## Maintenance review` section holding the inventory review paragraph:
//
//   ### Fixes
//
//   - What changed for users.
//
//   ## Maintenance review
//
//   Scope and result of the change for the inventory.
//
// Only Node built-ins: CI's `changes` job runs these tests without installing dependencies.

export const FRAGMENT_DIRECTORY = "changes";
export const FRAGMENT_PATTERN = /^changes\/(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REVIEW_HEADING = /^## Maintenance review[ \t]*$/m;

export class FragmentError extends Error {}

/** Whether a repository-relative path names a change fragment. */
export function isFragmentPath(file) {
  return FRAGMENT_PATTERN.test(file);
}

/**
 * Parses and validates one fragment.
 * @returns {{ file: string, date: string, sections: { heading: string | null, body: string }[], review: string }}
 */
export function parseFragment(file, text) {
  const name = FRAGMENT_PATTERN.exec(file);
  if (!name) {
    throw new FragmentError(
      `${file}: name fragments changes/YYYY-MM-DD-<slug>.md, with a lowercase slug of letters, digits and hyphens.`,
    );
  }
  const parts = text.split(REVIEW_HEADING);
  if (parts.length !== 2) {
    throw new FragmentError(`${file}: end with exactly one "## Maintenance review" section.`);
  }
  const [changelog, review] = parts.map((part) => part.trim());
  if (/^#{1,2} /m.test(changelog)) {
    throw new FragmentError(`${file}: use ### category headings above the maintenance review.`);
  }
  if (!/^- \S/m.test(changelog)) {
    throw new FragmentError(`${file}: add at least one changelog bullet.`);
  }
  if (!review || /^#/m.test(review)) {
    throw new FragmentError(`${file}: write one maintenance review paragraph under its heading.`);
  }
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of changelog.split(/\r?\n/)) {
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[1], lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  return {
    file,
    date: name[1],
    sections: sections
      .map(({ heading, lines }) => ({ heading, body: lines.join("\n").trim() }))
      .filter((section) => section.body),
    review: review.replace(/\s*\n\s*/g, " "),
  };
}

/**
 * Combines fragments, newest first by file name, into one changelog body grouped by
 * category (uncategorized bullets first, then categories in order of first appearance) and
 * one inventory review line per fragment.
 */
export function foldFragments(fragments) {
  // Paths are unique, so no two compare equal.
  const ordered = [...fragments].sort((a, b) => (a.file < b.file ? 1 : -1));
  const groups = new Map([[null, []]]);
  for (const fragment of ordered) {
    for (const { heading, body } of fragment.sections) {
      if (!groups.has(heading)) groups.set(heading, []);
      groups.get(heading).push(body);
    }
  }
  const blocks = [];
  for (const [heading, bodies] of groups) {
    if (!bodies.length) continue;
    const list = bodies.join("\n");
    blocks.push(heading === null ? list : `### ${heading}\n\n${list}`);
  }
  return {
    changelog: blocks.join("\n\n"),
    reviews: ordered.map((fragment) => `Maintenance review (${fragment.date}): ${fragment.review}`),
  };
}

/** Inserts `## <label> - <date>` with `body` above the changelog's first entry. */
export function insertChangelogEntry(changelog, label, date, body) {
  const entry = `## ${label} - ${date}\n\n${body ? `${body}\n\n` : ""}`;
  const first = changelog.search(/^## /m);
  if (first === -1) return `${changelog.trimEnd()}\n\n${entry}`;
  return `${changelog.slice(0, first)}${entry}${changelog.slice(first)}`;
}

/** Inserts review lines below the inventory's title, newest first, as one paragraph each. */
export function insertMaintenanceReviews(inventory, reviews) {
  if (!reviews.length) return inventory;
  const lines = inventory.split("\n");
  // Title, blank line, then the reviews.
  lines.splice(2, 0, ...reviews.flatMap((review) => [review, ""]));
  return lines.join("\n");
}
