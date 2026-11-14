import { isAvailable, getPane } from "./catalog";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_SLUGS } from "@/utils/host-routes";
import { en } from "@/i18n/resources/en";
import {
  SETTINGS_ENTRIES,
  SETTINGS_PANES,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_IDS,
  resolveSettingsTarget,
} from "./catalog";

const SRC = path.resolve(__dirname, "..");

/**
 * Source files rendered by each pane. The coverage check reads row labels from
 * these files, so a new row without a catalog entry fails here.
 */
const PANE_SOURCES: Record<string, readonly string[]> = {
  "general.installation": [
    "screens/settings/general/installation-name-section.tsx",
    "screens/settings/general/installation-type-section.tsx",
  ],
  "general.about": ["screens/settings/general/help-section.tsx"],
  "workspaces.newWorkspace": ["screens/settings/general/workspace-defaults-section.tsx"],
  "chat.sending": ["screens/settings/general/sending-section.tsx"],
  "general.notifications": ["desktop/components/desktop-notifications-section.tsx"],
  "chat.chat": ["screens/settings/chat/chat-section.tsx"],
  "chat.editor": ["screens/settings/editor-section.tsx"],
  "terminal.terminal": ["screens/settings/terminal/terminal-section.tsx"],
  "appearance.appearance": ["screens/settings/appearance/appearance-section.tsx"],
  "environments.environments": [
    "screens/settings/host-appearance-section.tsx",
    "execution-installation/resource-exclusions.tsx",
  ],
  "agents.metadata": ["screens/settings/metadata-generation-page.tsx"],
  "agents.browserData": ["desktop/browser/settings/browser-data-section.tsx"],
  "maintenance.installation": ["execution-installation/panel.tsx"],
  "system.overview": ["execution-installation/panel.tsx"],
};

/** Labels in pane sources that are not settings rows: dialogs, form fields and states. */
const NOT_ROWS = new Set([
  "settings.notifications.sentTitle",
  "settings.notifications.sendFailedTitle",
  "settings.metadataGeneration.model",
  "settings.metadataGeneration.docs",
  "settings.metadataGeneration.saveError",
  "settings.host.daemon.rename.title",
  "Dev preview monitor",
  "Native helper",
  "Waiting for compatible environments",
  // Sub-headings inside one instruction request's review, not settings rows.
  "Changes",
  "Full proposed instructions (applied exactly)",
  "Current instructions",
]);

function lookup(key: string): string | undefined {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Row labels a source file renders: `label=`, row titles and setting hints are excluded. */
function rowLabels(source: string): string[] {
  const labels = new Set<string>();
  const patterns = [
    /\blabel=\{t\("([^"]+)"\)\}/g,
    /\blabel="([^"]+)"/g,
    /rowTitle\}>\s*\{t\("([^"]+)"\)\}/g,
    /rowTitle\}>\s*([^<{][^<{]*?)\s*</g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) labels.add(match[1].trim());
  }
  return [...labels];
}

describe("settings catalog", () => {
  it("indexes installation identity, Help and delivery mode in their rendered panes", () => {
    const pane = (id: string) => SETTINGS_ENTRIES.find((entry) => entry.id === id)?.pane;
    expect(pane("general.installation.name")).toBe("general.installation");
    expect(pane("general.installation.type")).toBe("general.installation");
    expect(pane("general.help.diagnostics")).toBe("general.about");
    expect(pane("general.help.shortcuts")).toBe("general.about");
    expect(pane("general.help.discord")).toBe("general.about");
    expect(pane("general.help.github")).toBe("general.about");
    expect(pane("maintenance.installation.deliveryMode")).toBe("system.overview");
  });
  it("lists every section once, in order", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...SETTINGS_SECTION_IDS]);
  });

  it("gives every pane and entry a unique id and a known parent", () => {
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    expect(new Set(paneIds).size).toBe(paneIds.length);
    for (const pane of SETTINGS_PANES) {
      expect(SETTINGS_SECTION_IDS).toContain(pane.section);
      expect(resolveSettingsTarget(pane.id)).toEqual({ section: pane.section, pane: pane.id });
    }
    const entryIds = SETTINGS_ENTRIES.map((entry) => entry.id);
    expect(new Set(entryIds).size).toBe(entryIds.length);
    for (const entry of SETTINGS_ENTRIES) {
      expect(paneIds, entry.id).toContain(entry.pane);
    }
  });

  it("resolves translated labels for entries that name an i18n key", () => {
    for (const entry of SETTINGS_ENTRIES) {
      if (entry.labelKey) expect(lookup(entry.labelKey), entry.id).toBe(entry.label);
    }
  });

  it("indexes every pane that renders settings", () => {
    const indexed = new Set(SETTINGS_ENTRIES.map((entry) => entry.pane));
    const unindexed = SETTINGS_PANES.filter((pane) => !indexed.has(pane.id)).map((pane) => pane.id);
    expect(unindexed).toEqual([]);
  });

  it("routes every previous settings address to a pane", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      const target = resolveSettingsTarget(slug);
      if (slug === "general") continue;
      expect(target.pane ?? target.section, slug).not.toBe("general");
    }
    expect(resolveSettingsTarget("providers")).toEqual({
      section: "providers",
      pane: null,
    });
    expect(resolveSettingsTarget("diagnostics")).toEqual({
      section: "system",
      pane: "general.hosts",
    });
    expect(resolveSettingsTarget("about")).toEqual({ section: "system", pane: "general.about" });
    expect(resolveSettingsTarget("unknown")).toEqual({ section: "general", pane: null });
  });

  it("has an entry for every row label a pane renders", () => {
    const missing: string[] = [];
    let scanned = 0;
    // A shared module can export bodies for several panes. Every row must still be indexed
    // by a pane that actually renders that module, including System's Advanced controls.
    const sourcePanes = new Map<string, string[]>();
    for (const [paneId, files] of Object.entries(PANE_SOURCES)) {
      for (const file of files) sourcePanes.set(file, [...(sourcePanes.get(file) ?? []), paneId]);
    }
    for (const [file, paneIds] of sourcePanes) {
      const entries = SETTINGS_ENTRIES.filter((entry) => paneIds.includes(entry.pane));
      const known = new Set(entries.flatMap((entry) => [entry.label, entry.labelKey ?? ""]));
      const source = readFileSync(path.join(SRC, file), "utf8");
      for (const label of rowLabels(source)) {
        scanned += 1;
        if (NOT_ROWS.has(label) || known.has(label)) continue;
        const translated = lookup(label);
        if (translated && known.has(translated)) continue;
        missing.push(`${paneIds.join(", ")}: ${label}`);
      }
    }
    expect(missing).toEqual([]);
    // Guards the scanner itself: a broken pattern would otherwise pass vacuously.
    expect(scanned).toBeGreaterThan(25);
  });
});

it("offers keyboard shortcuts for hardware keyboards independently of Electron", () => {
  const pane = getPane("chat.shortcuts")!;
  const context = {
    isDesktopApp: false,
    isWeb: false,
    isNative: true,
    hasHosts: false,
    hasInstallation: false,
  };
  expect(isAvailable(pane, context)).toBe(false);
  expect(isAvailable(pane, { ...context, hardwareKeyboardPresent: true })).toBe(true);
});

it("groups the sections by scope and preserves renamed section links", () => {
  expect(SETTINGS_SECTIONS.map(({ label, group }) => [group, label])).toEqual([
    ["This device", "Interface"],
    ["Vorteo", "General"],
    ["Vorteo", "Providers"],
    ["Vorteo", "Agents"],
    ["Vorteo", "Voice"],
    ["Vorteo", "Projects & integrations"],
    ["Vorteo", "System"],
  ]);
  // Retired sections keep their addresses: Privacy in Interface, Environments and the old
  // General status row in System.
  expect(resolveSettingsTarget("privacy")).toEqual({
    section: "interface",
    pane: "general.notifications",
  });
  expect(resolveSettingsTarget("environments")).toEqual({
    section: "system",
    pane: "environments.environments",
  });
  expect(resolveSettingsTarget("general.attention")).toEqual({
    section: "system",
    pane: "system.health",
  });
  expect(resolveSettingsTarget("accounts")).toEqual({
    section: "providers",
    pane: "accounts.providers",
  });
  expect(resolveSettingsTarget("maintenance")).toEqual({
    section: "system",
    pane: "maintenance.installation",
  });
  expect(resolveSettingsTarget("workspaces")).toEqual({
    section: "general",
    pane: "workspaces.workspaces",
  });
  expect(resolveSettingsTarget("appearance")).toEqual({
    section: "interface",
    pane: "appearance.appearance",
  });
  // Upstream's per-host voice links land on the top-level Voice section.
  expect(resolveSettingsTarget("voice")).toEqual({ section: "voice", pane: null });
  expect(
    SETTINGS_ENTRIES.filter((entry) => entry.label === "Default profile").every(
      (entry) => entry.pane === "workspaces.newWorkspace",
    ),
  ).toBe(true);
});
