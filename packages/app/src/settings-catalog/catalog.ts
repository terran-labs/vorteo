/**
 * The settings catalog: every settings section, the panes each section stacks,
 * and a searchable entry for every setting a pane renders.
 *
 * Settings render as one continuous column of sections. Each pane reuses an
 * existing settings component; the catalog only decides order, grouping,
 * availability and search. Keep it free of React so search and coverage tests
 * run in plain Node.
 *
 * Adding a setting row to a pane means adding its entry here. The coverage test
 * in `catalog.test.ts` scans each pane's source for row labels and fails when a
 * label has no entry.
 */

// Notifications & privacy folded into Interface and Environments into System; their old
// addresses resolve through the panes' legacy slugs.
export const SETTINGS_SECTION_IDS = [
  "interface",
  "general",
  "providers",
  "agents",
  "voice",
  "projects",
  "system",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Where a setting's value lives, shown so owners know what a change affects. */
export type SettingScope = "device" | "installation" | "environment";

export interface SettingsAvailability {
  /** Electron desktop app only. */
  desktopOnly?: boolean;
  hardwareKeyboardOnly?: boolean;
  /** Browser and Electron only. */
  webOnly?: boolean;
  /** iOS and Android only. */
  nativeOnly?: boolean;
  /** Needs at least one connected environment. */
  requiresHost?: boolean;
  /** Needs a configured execution installation. */
  requiresInstallation?: boolean;
  /** Replaced by an installation-wide page when an installation exists. */
  withoutInstallation?: boolean;
}

export type SettingsGroupName = "This device" | "Vorteo";

/** i18n keys for the top-level groups; the English names stay the catalog's identifiers. */
export const SETTINGS_GROUP_LABEL_KEYS: Record<SettingsGroupName, string> = {
  "This device": "settings.groups.thisDevice",
  Vorteo: "settings.groups.vorteo",
};

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  group: SettingsGroupName;
  label: string;
  /** Extra words people use for this whole section. */
  keywords: readonly string[];
}

export interface SettingsPaneDefinition extends SettingsAvailability {
  id: string;
  section: SettingsSectionId;
  label: string;
  /** Old `/settings/<slug>` routes that now open this pane. */
  legacySlugs?: readonly string[];
  /** A subgroup within the section. */
  group?: string;
  keywords?: readonly string[];
}

export interface SettingsEntryDefinition extends SettingsAvailability {
  id: string;
  pane: string;
  /** Text shown on the row, used to find and highlight it after a jump. */
  label: string;
  /** i18n key for `label`, so search matches the translated row title. */
  labelKey?: string;
  hint?: string;
  hintKey?: string;
  keywords?: readonly string[];
  scope: SettingScope;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: "interface",
    group: "This device",
    label: "Interface",
    keywords: [
      "appearance",
      "language",
      "chat",
      "editor",
      "vim",
      "sending",
      "files",
      "terminal",
      "shortcuts",
    ],
  },
  {
    id: "general",
    group: "Vorteo",
    label: "General",
    keywords: [
      "home",
      "status",
      "attention",
      "installation",
      "name",
      "workspace",
      "defaults",
      "archive",
    ],
  },
  {
    id: "providers",
    group: "Vorteo",
    label: "Providers",
    keywords: [
      "accounts",
      "profiles",
      "providers",
      "presets",
      "usage",
      "quota",
      "login",
      "sign",
      "in",
    ],
  },
  {
    id: "agents",
    group: "Vorteo",
    label: "Agents",
    keywords: ["tools", "skills", "system", "prompt", "metadata", "browser", "terminal", "hooks"],
  },
  {
    // Its own section by the owner's choice: speech input and output, configured on the Host.
    id: "voice",
    group: "Vorteo",
    label: "Voice",
    keywords: ["voice", "dictation", "speech", "transcription", "speaking", "listening", "tts"],
  },
  {
    id: "projects",
    group: "Vorteo",
    label: "Projects & integrations",
    keywords: [
      "projects",
      "repositories",
      "worktrees",
      "plugins",
      "extensions",
      "integrations",
      "cli",
    ],
  },
  {
    id: "system",
    group: "Vorteo",
    label: "System",
    keywords: [
      "maintenance",
      "installation",
      "restart",
      "updates",
      "upstream",
      "diagnostics",
      "about",
      "version",
    ],
  },
];

export const SETTINGS_PANES: readonly SettingsPaneDefinition[] = [
  {
    id: "appearance.appearance",
    section: "interface",
    label: "Appearance",
    legacySlugs: ["appearance.appearance", "appearance"],
  },
  {
    // Which sidebar rows show and in what order, per device. The old Sidebar page's address
    // opens it.
    id: "appearance.sidebar",
    section: "interface",
    label: "Sidebar",
    legacySlugs: ["appearance.sidebar", "sidebar"],
    keywords: ["sidebar items", "navigation", "plugins", "order", "reorder", "hide", "show"],
  },
  {
    id: "appearance.language",
    legacySlugs: ["appearance.language"],
    section: "interface",
    label: "Language",
  },
  { id: "chat.chat", section: "interface", label: "Chat", legacySlugs: ["chat.chat", "chat"] },
  {
    id: "chat.sending",
    legacySlugs: ["chat.sending"],
    section: "interface",
    label: "Sending",
    hardwareKeyboardOnly: true,
    webOnly: true,
  },
  {
    id: "chat.files",
    section: "interface",
    label: "Files",
    legacySlugs: ["chat.files", "files"],
    keywords: ["file", "panel", "associations", "open with"],
  },
  {
    id: "chat.editor",
    section: "interface",
    label: "Editor",
    legacySlugs: ["chat.editor", "editor"],
    webOnly: true,
  },
  {
    id: "chat.openLocation",
    legacySlugs: ["chat.openLocation"],
    section: "interface",
    label: "Open location",
    desktopOnly: true,
  },
  {
    id: "terminal.terminal",
    section: "interface",
    label: "Terminal",
    legacySlugs: ["terminal.terminal", "terminal"],
  },
  {
    id: "chat.shortcuts",
    section: "interface",
    label: "Keyboard shortcuts",
    legacySlugs: ["chat.shortcuts", "shortcuts"],
    hardwareKeyboardOnly: true,
  },
  {
    id: "general.notifications",
    section: "interface",
    label: "Notifications",
    // The retired Notifications & privacy section's address lands here, in Interface.
    legacySlugs: ["general.notifications", "privacy.dataSaver", "notifications", "privacy"],
    keywords: ["privacy", "alerts"],
    desktopOnly: true,
  },
  {
    id: "agents.browserData",
    section: "interface",
    label: "Browser data",
    legacySlugs: ["agents.browserData", "browser"],
    keywords: ["privacy"],
    desktopOnly: true,
  },
  {
    id: "agents.permissions",
    section: "interface",
    label: "Permissions",
    legacySlugs: ["agents.permissions", "permissions"],
    keywords: ["privacy", "microphone"],
    desktopOnly: true,
  },
  {
    id: "general.installation",
    legacySlugs: ["general.installation"],
    section: "general",
    label: "Installation",
    requiresInstallation: true,
    keywords: ["name", "title", "rename", "type", "lab", "stable"],
  },
  {
    id: "workspaces.newWorkspace",
    legacySlugs: ["workspaces.newWorkspace"],
    section: "general",
    label: "New workspace",
    keywords: ["default", "new chat"],
  },
  {
    id: "workspaces.workspaces",
    section: "general",
    label: "Workspaces",
    legacySlugs: ["workspaces.workspaces", "workspaces"],
    requiresHost: true,
  },
  {
    id: "accounts.providers",
    section: "providers",
    label: "Providers",
    legacySlugs: ["accounts.providers", "providers", "accounts"],
    requiresHost: true,
  },
  {
    id: "accounts.profiles",
    section: "providers",
    label: "Profiles",
    legacySlugs: ["accounts.profiles", "profiles"],
    requiresHost: true,
    // Each provider's details show its profiles when an installation exists.
    withoutInstallation: true,
  },
  {
    id: "accounts.usage",
    section: "providers",
    label: "Usage",
    legacySlugs: ["accounts.usage", "usage"],
    requiresHost: true,
    // Usage sits on each connection in a provider's details when an installation exists.
    withoutInstallation: true,
  },
  {
    id: "agents.tools",
    section: "agents",
    label: "Agent tools",
    legacySlugs: ["agents.tools", "agents"],
    requiresHost: true,
  },
  {
    id: "agents.skills",
    section: "agents",
    label: "Skills",
    legacySlugs: ["agents.skills", "skills"],
  },
  {
    id: "voice.voice",
    section: "voice",
    label: "Voice",
    legacySlugs: ["voice.voice", "voice"],
    requiresHost: true,
  },
  {
    id: "terminal.profiles",
    section: "agents",
    label: "Terminal profiles",
    legacySlugs: ["terminal.profiles", "terminals"],
    requiresHost: true,
  },
  {
    // Last in Agents: it renders inside the section's collapsed Advanced group.
    id: "agents.metadata",
    section: "agents",
    label: "Metadata generation",
    legacySlugs: ["agents.metadata", "metadata"],
    requiresHost: true,
  },
  {
    id: "workspaces.projects",
    section: "projects",
    label: "Projects",
    legacySlugs: ["workspaces.projects", "projects"],
    requiresHost: true,
  },
  {
    id: "plugins.plugins",
    section: "projects",
    label: "Plugins",
    legacySlugs: ["plugins.plugins", "plugins"],
    requiresHost: true,
  },
  {
    id: "plugins.integrations",
    section: "projects",
    label: "Integrations",
    legacySlugs: ["plugins.integrations", "integrations"],
    desktopOnly: true,
  },
  {
    // Everything that needs the owner, each with a Fix that jumps to its control. Always first
    // in System; "System needs attention" and the old General status row lead here.
    id: "system.health",
    section: "system",
    label: "Health",
    legacySlugs: ["system.health", "health", "general.attention", "attention"],
    keywords: ["needs attention", "problems", "issues", "fix", "status"],
  },
  {
    // Host and Dev status, one action each, restarts, updates and technical details.
    id: "system.overview",
    section: "system",
    label: "System",
    legacySlugs: ["system.overview", "maintenance.updates", "maintenance.upstream"],
    keywords: ["status", "health", "restart", "update", "daemon", "host", "dev", "upstream"],
  },
  {
    // Environments is a group inside System; the old section address opens it.
    id: "environments.environments",
    section: "system",
    label: "Environments",
    legacySlugs: ["environments.environments", "environments"],
    keywords: ["hosts", "daemons", "machines", "servers"],
    requiresHost: true,
  },
  {
    id: "environments.connections",
    section: "system",
    label: "Connections",
    // Device pairing was retired in favor of authenticated direct connections.
    legacySlugs: ["environments.connections", "connections", "pair-device"],
    keywords: ["environments", "pair", "devices"],
  },
  {
    id: "general.about",
    section: "system",
    label: "About",
    legacySlugs: ["general.about", "about"],
  },
  {
    id: "general.hosts",
    section: "system",
    label: "Connected hosts",
    legacySlugs: ["general.hosts", "diagnostics"],
    keywords: ["diagnostics", "connection check"],
  },
  {
    id: "maintenance.installation",
    section: "system",
    label: "Installation controls",
    // Rendered inside System's collapsed Advanced group.
    group: "Advanced",
    legacySlugs: ["maintenance.installation", "maintenance"],
    requiresInstallation: true,
  },
];

const device = "device" as const;
const installation = "installation" as const;
const environment = "environment" as const;

export const SETTINGS_ENTRIES: readonly SettingsEntryDefinition[] = [
  {
    id: "system.health.list",
    pane: "system.health",
    label: "Health",
    keywords: ["needs attention", "problems", "issues", "fix", "all good"],
    scope: installation,
  },
  {
    id: "general.installation.name",
    pane: "general.installation",
    label: "Installation name",
    hint: "Shown in the browser tab, the welcome page and the sidebar.",
    keywords: ["name", "title", "rename"],
    scope: installation,
    requiresInstallation: true,
  },
  {
    id: "general.installation.type",
    pane: "general.installation",
    label: "Installation type",
    hint: "Stable installs tagged releases; Lab evolves itself from its live checkout.",
    keywords: ["lab", "stable", "self-update", "release channel"],
    scope: installation,
    requiresInstallation: true,
  },
  {
    id: "general.help.shortcuts",
    pane: "general.about",
    label: "Keyboard shortcuts",
    labelKey: "sidebar.help.shortcuts",
    keywords: ["help", "keyboard", "keys"],
    scope: device,
    hardwareKeyboardOnly: true,
  },
  {
    id: "general.help.diagnostics",
    pane: "general.about",
    label: "Run diagnostics",
    labelKey: "sidebar.help.diagnostics",
    keywords: ["help", "debug", "support", "logs"],
    scope: device,
  },
  {
    id: "general.help.discord",
    pane: "general.about",
    label: "Discord",
    labelKey: "sidebar.help.discord",
    keywords: ["help", "support", "report issue", "community"],
    scope: device,
  },
  {
    id: "general.help.github",
    pane: "general.about",
    label: "Create GitHub issue",
    labelKey: "sidebar.help.github",
    keywords: ["help", "support", "report bug", "issue"],
    scope: device,
  },
  // General
  {
    id: "general.notifications.permission",
    pane: "general.notifications",
    label: "Notification permission",
    labelKey: "settings.notifications.permission",
    keywords: ["alerts", "allow"],
    scope: device,
  },
  {
    id: "general.notifications.sound",
    pane: "general.notifications",
    label: "Play sound",
    labelKey: "settings.notifications.playSound",
    keywords: ["audio", "chime", "alert"],
    scope: device,
  },
  {
    id: "general.notifications.test",
    pane: "general.notifications",
    label: "Test notification",
    labelKey: "settings.notifications.test",
    scope: device,
  },
  {
    id: "general.about.version",
    pane: "general.about",
    label: "App version",
    labelKey: "settings.about.appVersion",
    keywords: ["build", "version number"],
    scope: device,
  },
  {
    id: "general.about.whatsNew",
    pane: "general.about",
    label: "What's new",
    labelKey: "changelog.title",
    keywords: ["changelog", "release notes"],
    scope: device,
  },
  {
    id: "general.about.github",
    pane: "general.about",
    label: "GitHub",
    labelKey: "settings.about.github",
    keywords: ["source code", "repository", "issues", "community"],
    scope: device,
  },
  {
    id: "general.about.releaseChannel",
    pane: "system.overview",
    label: "Release channel",
    labelKey: "settings.about.releaseChannel.label",
    keywords: ["beta", "stable"],
    desktopOnly: true,
    scope: device,
  },
  {
    id: "general.about.appUpdates",
    pane: "system.overview",
    label: "App updates",
    labelKey: "settings.about.updates.label",
    keywords: ["desktop update", "install update"],
    desktopOnly: true,
    scope: device,
  },
  {
    id: "general.hosts.versions",
    pane: "general.hosts",
    label: "Connected hosts",
    labelKey: "settings.about.connectedHosts",
    keywords: ["daemon version", "version mismatch"],
    scope: environment,
  },
  {
    id: "general.hosts.connectionCheck",
    pane: "system.overview",
    label: "Connection check",
    keywords: ["connection check", "host", "dev", "dns", "tailscale", "latency", "reachability"],
    scope: device,
  },
  {
    id: "general.hosts.legacyTerminalRenderer",
    pane: "terminal.terminal",
    label: "Use legacy terminal renderer",
    labelKey: "settings.diagnostics.legacyTerminalRenderer.label",
    keywords: ["webview", "terminal"],
    nativeOnly: true,
    scope: device,
  },
  {
    id: "general.hosts.app",
    pane: "general.hosts",
    label: "App diagnostic",
    labelKey: "settings.diagnostics.app.rowTitle",
    keywords: ["logs", "debug", "troubleshoot", "support"],
    scope: device,
  },
  {
    id: "general.hosts.audio",
    pane: "general.hosts",
    label: "Test audio",
    labelKey: "settings.diagnostics.testAudio",
    keywords: ["sound", "speaker", "voice"],
    scope: device,
  },

  // Accounts & profiles
  {
    id: "accounts.providers.list",
    pane: "accounts.providers",
    label: "Providers",
    keywords: [
      "accounts",
      "connections",
      "claude",
      "codex",
      "copilot",
      "opencode",
      "pi",
      "connect",
      "sign in",
      "profiles",
      "default profile",
      "model defaults",
      "usage",
      "plan usage",
      "environment access",
    ],
    scope: environment,
  },
  {
    id: "accounts.providers.order",
    pane: "accounts.providers",
    label: "Provider order",
    keywords: ["reorder", "drag", "priority"],
    scope: installation,
  },
  {
    id: "accounts.profiles.default",
    pane: "workspaces.newWorkspace",
    label: "Default profile",
    keywords: ["preset", "default configuration"],
    scope: installation,
  },
  {
    id: "accounts.profiles.list",
    pane: "accounts.profiles",
    label: "Profiles",
    keywords: ["presets", "workflows", "model", "reasoning", "instructions", "workers"],
    scope: installation,
  },
  {
    id: "accounts.profiles.launchDefaults",
    pane: "accounts.profiles",
    label: "Edit defaults",
    keywords: ["provider defaults", "launch defaults", "model picker"],
    scope: installation,
  },
  {
    id: "accounts.profiles.olderCopies",
    pane: "accounts.profiles",
    label: "Older copies",
    keywords: ["duplicate profiles", "legacy profiles", "migrated profiles"],
    scope: installation,
  },
  {
    id: "accounts.profiles.preferredModels",
    pane: "accounts.profiles",
    label: "Preferred models and reasoning",
    keywords: ["model picker", "favorites"],
    scope: installation,
  },
  {
    id: "accounts.profiles.preferredReasoning",
    pane: "accounts.profiles",
    label: "Preferred reasoning",
    keywords: ["thinking", "effort"],
    scope: installation,
  },
  {
    id: "accounts.usage.plan",
    pane: "accounts.usage",
    label: "Plan usage",
    hint: "Each account also shows its quota beside its status.",
    keywords: ["quota", "limits", "credits", "reset", "weekly", "session"],
    scope: environment,
  },

  // Agent behavior
  {
    id: "agents.tools.vorteoTools",
    pane: "agents.tools",
    label: "Enable Vorteo tools",
    keywords: ["mcp", "worktrees", "schedules", "orchestration"],
    scope: installation,
  },
  {
    id: "agents.tools.browserTools",
    pane: "agents.tools",
    label: "Browser tools",
    keywords: ["browser automation", "tabs", "screenshots", "playwright"],
    scope: installation,
  },
  {
    id: "agents.tools.systemPrompt",
    pane: "agents.tools",
    label: "System prompt",
    keywords: ["instructions", "custom prompt"],
    scope: installation,
  },
  {
    id: "agents.tools.orchestrationSkills",
    pane: "agents.skills",
    label: "Orchestration skills",
    keywords: ["skill library"],
    scope: environment,
  },
  {
    id: "voice.voice.dictation",
    pane: "voice.voice",
    label: "Dictation",
    labelKey: "settings.voice.dictation.enabled",
    hint: "Speak into the message box instead of typing.",
    keywords: ["dictate", "speech to text", "microphone"],
    scope: environment,
  },
  {
    id: "voice.voice.mode",
    pane: "voice.voice",
    label: "Voice mode",
    labelKey: "settings.voice.voiceMode.enabled",
    hint: "Talk with your agents hands-free.",
    keywords: ["hands-free", "read aloud", "conversation"],
    scope: environment,
  },
  {
    id: "voice.voice.models",
    pane: "voice.voice",
    label: "Speech models",
    keywords: [
      "speech-to-text",
      "listening",
      "speaking",
      "whisper",
      "openai",
      "local model",
      "download",
    ],
    scope: environment,
  },
  {
    id: "agents.skills.library",
    pane: "agents.skills",
    label: "Filter skills",
    keywords: ["skills", "install skill", "github", "discovery paths", "inventory"],
    scope: environment,
  },
  {
    id: "agents.metadata.model",
    pane: "agents.metadata",
    label: "Model selection",
    labelKey: "settings.metadataGeneration.selection",
    keywords: ["titles", "branch names", "commit messages", "pull request drafts"],
    scope: installation,
  },
  {
    id: "agents.browserData.clear",
    pane: "agents.browserData",
    label: "Cookies and site data",
    labelKey: "settings.general.browserData.siteData",
    keywords: ["clear browser data", "sign-ins"],
    scope: device,
  },
  {
    id: "agents.permissions.microphone",
    pane: "agents.permissions",
    label: "Microphone",
    labelKey: "settings.permissions.microphone",
    keywords: ["voice", "dictation", "audio"],
    scope: device,
  },

  // Chat & editor
  {
    id: "chat.sending.shortcut",
    pane: "chat.sending",
    hardwareKeyboardOnly: true,
    webOnly: true,
    label: "Send shortcut",
    labelKey: "settings.general.sendShortcut.label",
    keywords: ["enter", "command", "control", "keyboard"],
    scope: device,
  },
  {
    id: "chat.files.associations",
    pane: "chat.files",
    label: "Files",
    labelKey: "settings.files.title",
    keywords: ["file types", "open with", "panel associations", "ask again", "plugins"],
    scope: device,
  },
  {
    id: "chat.chat.reasoning",
    pane: "chat.chat",
    label: "Always expand reasoning",
    labelKey: "settings.general.autoExpandReasoning.label",
    keywords: ["thinking", "chain of thought"],
    scope: device,
  },
  {
    id: "chat.chat.toolCalls",
    pane: "chat.chat",
    label: "Chat display",
    labelKey: "settings.general.chatDisplay.label",
    keywords: ["summary", "full detail", "timeline", "tool calls", "collapse turns"],
    scope: device,
  },
  {
    id: "chat.chat.outline",
    pane: "chat.chat",
    label: "Chat outline",
    labelKey: "settings.appearance.chatOutline.title",
    keywords: ["jump between prompts", "navigation"],
    scope: device,
  },

  {
    id: "chat.openLocation.destinations",
    pane: "chat.openLocation",
    label: "Open location",
    labelKey: "settings.layout.openInSidePane.title",
    keywords: ["side pane", "split", "explorer", "diffs", "service urls"],
    scope: device,
  },
  {
    id: "chat.editor.vim",
    pane: "chat.editor",
    label: "Vim keybindings",
    labelKey: "settings.editor.vimKeybindings",
    keywords: ["vi", "modal editing", "keyboard"],
    scope: device,
  },
  {
    id: "chat.shortcuts.list",
    pane: "chat.shortcuts",
    label: "Keyboard shortcuts",
    keywords: ["keyboard shortcuts", "hotkeys", "keybindings", "rebind"],
    scope: device,
  },

  // Terminal
  {
    id: "terminal.terminal.scrollback",
    pane: "terminal.terminal",
    label: "Terminal scrollback",
    labelKey: "settings.general.terminalScrollback.label",
    keywords: ["buffer", "lines", "history"],
    scope: device,
  },
  {
    id: "terminal.profiles.hooks",
    pane: "terminal.profiles",
    label: "Enable terminal agent hooks",
    keywords: ["notifications", "status", "terminal agents"],
    scope: environment,
  },
  {
    id: "terminal.profiles.list",
    pane: "terminal.profiles",
    label: "Terminal profiles",
    labelKey: "settings.host.terminalProfiles.sectionTitle",
    keywords: ["claude code", "codex", "opencode", "commands", "launch"],
    scope: installation,
  },

  // Sidebar
  {
    id: "appearance.sidebar.header",
    pane: "appearance.sidebar",
    label: "Header",
    labelKey: "settings.appearance.sidebar.header.title",
    hint: "Show, hide and reorder plugin items at the top of the sidebar",
    keywords: ["sidebar items", "sidebar header", "plugin items", "reorder", "hide"],
    scope: device,
  },
  {
    id: "appearance.sidebar.footer",
    pane: "appearance.sidebar",
    label: "Footer",
    labelKey: "settings.appearance.sidebar.footer.title",
    hint: "Show, hide and reorder plugin rows at the bottom of the sidebar",
    keywords: ["sidebar items", "sidebar footer", "plugin rows", "reorder", "hide"],
    scope: device,
  },
  // Appearance
  {
    id: "appearance.theme",
    pane: "appearance.appearance",
    label: "Theme",
    labelKey: "settings.appearance.theme.title",
    keywords: ["dark", "light", "midnight", "claude", "ghostty", "pure black", "colors"],
    scope: device,
  },
  {
    id: "appearance.interfaceFont",
    pane: "appearance.appearance",
    label: "Interface font",
    labelKey: "settings.appearance.fonts.interfaceFont",
    keywords: ["typeface", "font family"],
    scope: device,
  },
  {
    id: "appearance.interfaceSize",
    pane: "appearance.appearance",
    label: "Interface size",
    labelKey: "settings.appearance.fonts.interfaceSize",
    keywords: ["font size", "zoom", "text size"],
    scope: device,
  },
  {
    id: "appearance.contentSize",
    pane: "appearance.appearance",
    label: "Content size",
    labelKey: "settings.appearance.fonts.contentSize",
    keywords: ["font size", "markdown", "chat text"],
    scope: device,
  },
  {
    id: "appearance.codeFont",
    pane: "appearance.appearance",
    label: "Code font",
    labelKey: "settings.appearance.fonts.codeFont",
    keywords: ["monospace", "terminal font"],
    scope: device,
  },
  {
    id: "appearance.codeSize",
    pane: "appearance.appearance",
    label: "Code size",
    labelKey: "settings.appearance.fonts.codeSize",
    keywords: ["monospace", "font size"],
    scope: device,
  },
  {
    id: "appearance.contentWidth",
    pane: "appearance.appearance",
    label: "Content width",
    labelKey: "settings.appearance.layout.contentWidth",
    keywords: ["max width", "column", "wide screens"],
    scope: device,
  },
  {
    id: "appearance.workspaceStatusLine",
    pane: "appearance.appearance",
    label: "Workspace status line",
    labelKey: "settings.appearance.statusLine.label",
    hintKey: "settings.appearance.statusLine.hint",
    keywords: ["sidebar", "factory", "status", "second line", "hover"],
    scope: device,
  },
  {
    id: "appearance.highlightTheme",
    pane: "appearance.appearance",
    label: "Highlight theme",
    labelKey: "settings.appearance.syntax.highlightTheme",
    keywords: ["syntax", "code colors"],
    scope: device,
  },
  {
    id: "appearance.language",
    pane: "appearance.language",
    label: "Language",
    labelKey: "settings.general.language.label",
    keywords: ["locale", "translation", "english", "spanish", "japanese"],
    scope: device,
  },

  // Workspaces & projects
  {
    id: "workspaces.newWorkspace.environment",
    pane: "workspaces.newWorkspace",
    label: "Default environment",
    keywords: ["new workspace", "host", "where new chats run"],
    scope: installation,
  },
  {
    id: "workspaces.newWorkspace.account",
    pane: "workspaces.newWorkspace",
    label: "Default account",
    keywords: ["new chat", "provider", "claude", "codex"],
    scope: installation,
  },
  {
    id: "workspaces.newWorkspace.profile",
    pane: "workspaces.newWorkspace",
    label: "Default profile",
    keywords: ["new chat", "preset", "model"],
    scope: installation,
  },
  {
    id: "workspaces.projects.list",
    pane: "workspaces.projects",
    label: "Projects",
    labelKey: "settings.hostSections.projects",
    keywords: ["repositories", "folders", "project settings"],
    scope: installation,
  },
  {
    id: "workspaces.archiveMerged",
    pane: "workspaces.workspaces",
    label: "Archive merged PR workspaces",
    keywords: ["auto archive", "pull request", "cleanup"],
    scope: environment,
  },

  // Environments
  {
    id: "environments.name",
    pane: "environments.environments",
    label: "Name",
    labelKey: "settings.host.appearance.name.label",
    keywords: ["rename host", "label"],
    scope: device,
  },
  {
    id: "environments.color",
    pane: "environments.environments",
    label: "Color",
    labelKey: "settings.host.appearance.color.label",
    keywords: ["host color"],
    scope: device,
  },
  {
    id: "environments.badge",
    pane: "environments.environments",
    label: "Sidebar badge",
    labelKey: "settings.host.appearance.badge.label",
    keywords: ["host badge"],
    scope: device,
  },
  {
    id: "environments.restart",
    pane: "environments.environments",
    label: "Restart daemon",
    labelKey: "settings.host.daemon.restart.title",
    keywords: ["reboot", "reload host"],
    scope: environment,
  },
  {
    id: "environments.update",
    pane: "environments.environments",
    label: "Update daemon",
    labelKey: "settings.host.daemon.update.title",
    keywords: ["upgrade host"],
    scope: environment,
  },
  {
    id: "environments.remove",
    pane: "environments.environments",
    label: "Remove host",
    labelKey: "settings.host.daemon.remove.title",
    keywords: ["delete host", "disconnect", "danger zone"],
    scope: device,
  },
  {
    id: "environments.exceptions",
    pane: "environments.environments",
    label: "Environment exceptions",
    keywords: ["exclusions", "excluded profiles", "availability"],
    scope: installation,
  },
  {
    id: "environments.connections.list",
    pane: "environments.connections",
    label: "Connections",
    labelKey: "settings.host.connections.title",
    keywords: ["add connection", "ssh", "relay", "tcp", "remote host", "pair device", "phone"],
    scope: device,
  },

  // Plugins & integrations
  {
    id: "plugins.enable",
    pane: "plugins.plugins",
    label: "Enable plugins",
    labelKey: "settings.plugins.globalTitle",
    keywords: ["extensions", "install plugin", "trusted plugins"],
    scope: installation,
  },
  {
    id: "plugins.integrations.cli",
    pane: "plugins.integrations",
    label: "Command line",
    labelKey: "settings.integrations.commandLine.title",
    keywords: ["cli", "install", "terminal command"],
    scope: device,
  },

  // Maintenance
  {
    id: "system.overview.customDomain",
    pane: "system.overview",
    label: "Custom domain",
    keywords: ["advanced", "https", "dns", "tls", "installation address"],
    requiresInstallation: true,
    scope: installation,
  },
  {
    id: "system.overview.domain",
    pane: "system.overview",
    label: "Domain",
    keywords: ["custom domain", "advanced", "https", "installation address"],
    requiresInstallation: true,
    scope: installation,
  },
  {
    id: "system.overview.resumeOnStartup",
    pane: "system.overview",
    label: "Resume agents after restart",
    labelKey: "settings.host.agents.resumeOnStartup.title",
    hint: "Continue interrupted work automatically.",
    keywords: ["restart", "crash", "resume prompt", "interrupted"],
    scope: environment,
  },
  {
    id: "system.overview.idleRuntimeCleanup",
    pane: "system.overview",
    label: "Release idle agents",
    labelKey: "settings.host.agents.idleRuntimeCleanup.title",
    hint: "Free up memory after an hour of inactivity.",
    keywords: ["memory", "idle", "stop process"],
    scope: environment,
  },
  {
    id: "system.overview.blockedWorkReview",
    pane: "system.overview",
    label: "Review blocked work",
    labelKey: "settings.host.agents.blockedWorkReview.title",
    hint: "Off by default. Up to three short reviews after a thread stops.",
    keywords: ["blocked", "stuck", "usage", "weekly limit", "tokens", "review"],
    scope: environment,
  },
  {
    id: "maintenance.installation.access",
    pane: "maintenance.installation",
    label: "Installation owner",
    keywords: ["owner password", "unlock", "lock controls"],
    scope: installation,
  },
  {
    id: "maintenance.installation.owner",
    pane: "maintenance.installation",
    label: "Owner password",
    keywords: ["unlock", "owner access", "lock controls"],
    scope: installation,
  },
  {
    id: "maintenance.installation.restarts",
    pane: "maintenance.installation",
    label: "Host and container",
    keywords: ["restart approvals", "approve restart", "restart history", "daemon"],
    scope: installation,
  },
  {
    id: "maintenance.installation.automatic",
    pane: "maintenance.installation",
    label: "Automatic updates and restarts",
    keywords: ["auto update", "idle restart"],
    scope: installation,
  },
  {
    id: "maintenance.installation.authorization",
    pane: "maintenance.installation",
    label: "Automatic maintenance authorization",
    scope: installation,
  },
  {
    id: "maintenance.installation.instructions",
    pane: "maintenance.installation",
    label: "Agent instruction changes",
    keywords: ["system prompt", "instruction request", "approve instructions"],
    scope: installation,
  },
  {
    id: "maintenance.installation.deliveryMode",
    pane: "system.overview",
    label: "Live development",
    keywords: ["live dev", "delivery mode", "fast refresh", "hot reload", "lab", "live checkout"],
    scope: installation,
  },
  {
    id: "maintenance.installation.sessionHost",
    pane: "maintenance.installation",
    label: "Session host",
    keywords: ["durable sessions", "session host install"],
    scope: installation,
  },
  {
    id: "maintenance.updates.vorteo",
    pane: "system.overview",
    label: "Vorteo updates",
    labelKey: "settings.about.vortonUpdates.title",
    keywords: ["check for updates", "new commits", "host update task"],
    scope: installation,
  },
  {
    id: "maintenance.upstream.merge",
    pane: "system.overview",
    label: "Paseo upstream updates",
    labelKey: "settings.about.upstreamUpdates.title",
    keywords: ["upstream merge", "host merge task", "copy host prompt"],
    scope: installation,
  },
];

export interface SettingsTarget {
  section: SettingsSectionId;
  /** The pane to scroll to, or null for the top of the section. */
  pane: string | null;
}

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

/**
 * Resolves a `/settings/<slug>` route to where it now lives. New section ids
 * open the section; slugs from the previous layout open the pane that absorbed
 * them, so bookmarks and agent-provided links keep working.
 */
export function resolveSettingsTarget(slug: string): SettingsTarget {
  if (isSettingsSectionId(slug)) return { section: slug, pane: null };
  const pane = SETTINGS_PANES.find(
    (candidate) => candidate.id === slug || candidate.legacySlugs?.includes(slug),
  );
  if (pane) return { section: pane.section, pane: pane.id };
  return { section: "general", pane: null };
}

export interface SettingsAvailabilityContext {
  hardwareKeyboardPresent?: boolean;
  isDesktopApp: boolean;
  isWeb: boolean;
  isNative: boolean;
  hasHosts: boolean;
  hasInstallation: boolean;
}

export function isAvailable(
  item: SettingsAvailability,
  context: SettingsAvailabilityContext,
): boolean {
  if (item.hardwareKeyboardOnly && !context.hardwareKeyboardPresent) return false;
  if (item.desktopOnly && !context.isDesktopApp) return false;
  if (item.webOnly && !context.isWeb) return false;
  if (item.nativeOnly && !context.isNative) return false;
  if (item.requiresHost && !context.hasHosts) return false;
  if (item.requiresInstallation && !context.hasInstallation) return false;
  if (item.withoutInstallation && context.hasInstallation) return false;
  return true;
}

export function getSection(id: SettingsSectionId): SettingsSectionDefinition {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

export function getPane(id: string): SettingsPaneDefinition | undefined {
  return SETTINGS_PANES.find((pane) => pane.id === id);
}

export function panesForSection(
  section: SettingsSectionId,
  context: SettingsAvailabilityContext,
): SettingsPaneDefinition[] {
  return SETTINGS_PANES.filter((pane) => pane.section === section && isAvailable(pane, context));
}
