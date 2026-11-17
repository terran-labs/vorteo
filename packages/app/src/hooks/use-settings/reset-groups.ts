import { useCallback } from "react";
import { confirmDialog } from "@/utils/confirm-dialog";
import { DEFAULT_CLIENT_SETTINGS, type AppSettings } from "./storage";

/**
 * Device settings grouped the way the settings page shows them, so each group's Reset restores
 * exactly the values that group's controls write. A key belongs to one group only. Values kept
 * outside app settings, such as web interface zoom, are not reset here.
 */
export const SETTINGS_RESET_GROUPS = {
  // Zoom sits in the Theme card but lives outside app settings, so the dialog says so.
  theme: { title: "theme", keys: ["theme", "pluginThemeId"], note: "Zoom is not changed." },
  fonts: {
    title: "fonts",
    keys: ["uiFontFamily", "monoFontFamily", "uiBaseFontSize", "contentFontSize", "codeFontSize"],
  },
  layout: { title: "layout", keys: ["contentMaxWidth"] },
  // Titled after its section heading, Appearance > Sidebar.
  statusLine: { title: "sidebar", keys: ["workspaceStatusLine"] },
  syntax: { title: "syntax highlighting", keys: ["syntaxTheme"] },
  sidebar: { title: "sidebar items", keys: ["sidebarNavItems", "sidebarFooterItems"] },
  chat: { title: "chat", keys: ["autoExpandReasoning", "chatDisplay", "chatOutlineEnabled"] },
  sending: { title: "sending", keys: ["sendShortcut", "sendBehavior"] },
  editor: { title: "editor", keys: ["vimKeybindings"] },
  terminal: { title: "terminal", keys: ["terminalScrollbackLines", "useLegacyTerminalRenderer"] },
  files: { title: "file associations", keys: ["filePanelAssociations"] },
  openLocation: {
    title: "open locations",
    keys: ["openInSidePane", "pullRequestOpenLocation", "serviceUrlBehavior"],
  },
  workspaceRows: {
    title: "workspace rows",
    keys: [
      "workspaceTitleSource",
      "sidebarWorkspaceTrailing",
      "sidebarRowItems",
      "sidebarChecksDisplay",
    ],
  },
} as const satisfies Record<
  string,
  { title: string; keys: readonly (keyof AppSettings)[]; note?: string }
>;

export type SettingsResetGroup = keyof typeof SETTINGS_RESET_GROUPS;

/** The defaults for one group, ready to pass to `updateSettings`. */
export function settingsGroupDefaults(group: SettingsResetGroup): Partial<AppSettings> {
  const defaults: Partial<AppSettings> = {};
  for (const key of SETTINGS_RESET_GROUPS[group].keys) {
    Object.assign(defaults, { [key]: DEFAULT_CLIENT_SETTINGS[key] });
  }
  return defaults;
}

/** True when every key in the group already holds its default, so Reset has nothing to do. */
export function isSettingsGroupDefault(settings: AppSettings, group: SettingsResetGroup): boolean {
  return SETTINGS_RESET_GROUPS[group].keys.every(
    (key) => JSON.stringify(settings[key]) === JSON.stringify(DEFAULT_CLIENT_SETTINGS[key]),
  );
}

/**
 * Asks once, then restores one group to its defaults. Resolves true when the reset was saved.
 * Pass the `updateSettings` from `useAppSettings` or `useSettings`.
 */
export function useResetSettingsGroup(
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>,
): (group: SettingsResetGroup) => Promise<boolean> {
  return useCallback(
    async (group: SettingsResetGroup) => {
      const definition: { title: string; note?: string } = SETTINGS_RESET_GROUPS[group];
      const { title, note } = definition;
      const confirmed = await confirmDialog({
        title: `Reset ${title}?`,
        message: `Restores the default ${title} settings on this device.${note ? ` ${note}` : ""}`,
        confirmLabel: "Reset",
      });
      if (!confirmed) return false;
      await updateSettings(settingsGroupDefaults(group));
      return true;
    },
    [updateSettings],
  );
}
