import type { Href } from "expo-router";
import { scoreTextFields } from "@getpaseo/protocol/search/text-match";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  getSection,
  resolveSettingsTarget,
  type SettingsSectionId,
} from "@/settings-catalog/catalog";
import type { SettingsPageSection } from "./settings-scroll-page";

/**
 * The section the address names. Host overview addresses
 * (`/settings/hosts/<id>/host`) open Environments, which lives in System.
 */
export function sectionForPath(pathname: string): SettingsSectionId {
  const slug = pathname.split("/")[2] ?? "";
  return slug === "hosts" ? "system" : resolveSettingsTarget(slug).section;
}

/** `/settings/<section>`, with `?setting=` to land on one row. */
export function settingsLink(section: SettingsSectionId, settingId?: string): Href {
  const path = buildSettingsSectionRoute(section);
  return (settingId ? `${path}?setting=${encodeURIComponent(settingId)}` : path) as Href;
}

/** Panes whose own title, or whose section's, matches the query. */
export function matchPanes(sections: readonly SettingsPageSection[], query: string): Set<string> {
  const matched = new Set<string>();
  if (!query.trim()) return matched;
  const options = { typoTolerant: true, subsequence: false } as const;
  for (const section of sections) {
    const meta = getSection(section.id);
    const sectionHit = scoreTextFields(query, [section.label, ...meta.keywords], options);
    for (const pane of section.panes) {
      if (sectionHit || scoreTextFields(query, [pane.label, ...(pane.keywords ?? [])], options)) {
        matched.add(pane.id);
      }
    }
  }
  return matched;
}
