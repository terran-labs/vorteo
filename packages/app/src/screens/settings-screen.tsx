import { OwnerLockBadge } from "@/components/settings/owner-lock";
import { SettingsCloseGesture } from "./settings/close-gesture";
import {
  SettingsAdvancedGroup,
  SettingsCard,
  SettingsDetailRow,
  SettingsGroup,
  SettingsSectionTrailing,
} from "@/components/settings";
import { ResetGroupButton } from "@/screens/settings/appearance/reset-group-button";
import type { SettingsResetGroup } from "@/hooks/use-settings";
import { selectSettingsHost } from "@/navigation/settings-presentation";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { useAddHost } from "@/hosts/add-host";
import { FilesSection } from "@/screens/settings/files-section";
import { SidebarIdentityFooter } from "@/components/sidebar-identity-footer";
import { InstallationNameSection } from "@/screens/settings/general/installation-name-section";
import { HelpSection } from "@/screens/settings/general/help-section";
import { SystemPane } from "@/screens/settings/system/system-pane";
import {
  InstallationRestartBanner,
  InstallationControls,
  InstallationSystemAdvanced,
} from "@/execution-installation/panel";
import { UpstreamUpdatesSection } from "@/vorton-updates/upstream-section";
import { SystemProjectCard } from "@/execution-installation/system-project-card";
import { WorkspaceDefaultsSection } from "@/screens/settings/general/workspace-defaults-section";
import { SystemHealthSection } from "@/screens/settings/general/attention-section";
import { registerSettingsJump, type SettingsJumpTarget } from "@/screens/settings/settings-jump";
import { EnvironmentsPane } from "./settings/environments-page";
import { SkillLibraryContent } from "@/agent-skills/library";
import { useCallback, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Buffer } from "buffer";
import {
  ArrowLeft,
  Settings,
  Palette,
  Server,
  Bot,
  Plus,
  FolderGit2,
  Sparkles,
  Mic,
  Wrench,
  ChevronRight,
  ExternalLink,
} from "lucide-react-native";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import { SidebarNavSection } from "@/screens/settings/sidebar/sidebar-nav-section";
import { HostVoicePage } from "@/screens/settings/voice/voice-page";
import { OpenLocationSection } from "@/screens/settings/open-location/open-location-section";
import { TerminalSection } from "@/screens/settings/terminal/terminal-section";
import { ChatSection } from "@/screens/settings/chat/chat-section";
import { SendingSection } from "@/screens/settings/general/sending-section";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { type HostProfile } from "@/types/host-connection";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { BackHeader } from "@/components/headers/back-header";
import { PageLayout } from "@/components/page-layout";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { EditorSection } from "@/screens/settings/editor-section";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { VORTEO_GITHUB_URL } from "@/components/community-links";
import { GitHubIcon } from "@/components/icons/github-icon";
import { openExternalUrl } from "@/utils/open-external-url";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { isElectronRuntime } from "@/desktop/host";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { useVortonUpdate } from "@/vorton-updates/use-update";
import { openChangelog } from "@/changelog";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { settingsStyles } from "@/styles/settings";
import { hoverStyle } from "@/styles/hover";
import {
  floatingPanelStyles,
  FLOATING_PANEL_INSET,
  FLOATING_PANEL_CONTROL_HEIGHT,
} from "@/styles/floating-panel";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";
import { toErrorMessage } from "@/utils/error-messages";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  type AppLanguage,
  type SupportedLocale,
} from "@/i18n/locales";
import { PluginSettingsContent } from "@/plugins/settings";
import { useInstalledPlugins } from "@/plugins/registry";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import {
  SETTINGS_DESKTOP_SIDEBAR_WIDTH,
  VORTON_HEADER_HEIGHT,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useEnableBuiltInDaemonOption } from "@/desktop/hooks/use-enable-built-in-daemon-option";
import { buildSettingsHostSectionRoute, buildSettingsSectionRoute } from "@/utils/host-routes";
import { returnFromSettings, type SettingsView } from "@/navigation/settings-navigation";
import { SettingsFocusContext } from "@/screens/settings/settings-focus";
import { isNative, isWeb } from "@/constants/platform";
import { InstallationSettingsContent } from "@/screens/settings/installation-sections";
import { readExecutionInstallation } from "@/execution-installation/policy";
import {
  SETTINGS_ENTRIES,
  SETTINGS_GROUP_LABEL_KEYS,
  SETTINGS_SECTIONS,
  type SettingsGroupName,
  getPane,
  getSection,
  isAvailable,
  panesForSection,
  type SettingsAvailabilityContext,
  type SettingsSectionId,
} from "@/settings-catalog/catalog";
import {
  SIDEBAR_CONTROL_HEIGHT,
  SettingsScrollPage,
  SettingsSearchBox,
  type ResolvedSettingsEntry,
  type SettingsPageSection,
  type SettingsSearchControls,
} from "@/screens/settings/settings-scroll-page";
import { useSettingsNavigation } from "@/screens/settings/use-settings-navigation";
import { useSettingsSearchShortcut } from "@/screens/settings/use-settings-search-shortcut";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

type IconComponent = ComponentType<{
  size: number;
  color: string;
  strokeWidth?: number;
}>;

const SECTION_ICONS: Record<SettingsSectionId, IconComponent> = {
  interface: Palette,
  general: Settings,
  providers: Bot,
  agents: Sparkles,
  voice: Mic,
  projects: FolderGit2,
  system: Wrench,
};

/** The section a drill-in page belongs to, for the sidebar highlight. */
function sectionForView(view: SettingsView): SettingsSectionId | null {
  if (view.kind === "project") return "projects";
  if (view.kind === "plugin") return "projects";
  return null;
}

/** The sidebar highlight: none while searching, else the section in view or owning a drill-in. */
function selectedSidebarSection(
  view: SettingsView,
  searching: boolean,
  activeSection: SettingsSectionId,
): SettingsSectionId | null {
  if (searching) return null;
  return view.kind === "section" ? activeSection : sectionForView(view);
}

function useAvailabilityContext(): SettingsAvailabilityContext {
  const hosts = useHosts();
  const isDesktopApp = isElectronRuntime();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  const hasInstallation = readExecutionInstallation() !== null;
  return useMemo(
    () => ({
      isDesktopApp,
      hardwareKeyboardPresent,
      isWeb,
      isNative,
      hasHosts: hosts.length > 0,
      hasInstallation,
    }),
    [hasInstallation, hosts.length, isDesktopApp, hardwareKeyboardPresent],
  );
}

function useSettingsSections(context: SettingsAvailabilityContext): SettingsPageSection[] {
  return useMemo(
    () =>
      SETTINGS_SECTIONS.map((section) => ({
        id: section.id,
        label: section.label,
        panes: panesForSection(section.id, context),
      })).filter((section) => section.panes.length > 0),
    [context],
  );
}

/** Catalog entries for this device, translated, plus live names such as environments. */
function useSearchEntries(
  sections: readonly SettingsPageSection[],
  context: SettingsAvailabilityContext,
): ResolvedSettingsEntry[] {
  const { t } = useTranslation();
  const hosts = useHosts();
  return useMemo(() => {
    const available = new Set(sections.flatMap((section) => section.panes.map((pane) => pane.id)));
    const breadcrumbFor = (paneId: string) => {
      const pane = getPane(paneId);
      const section = pane ? getSection(pane.section) : null;
      return section && pane && section.label !== pane.label
        ? `${section.label} › ${pane.label}`
        : (section?.label ?? "");
    };
    const contextFor = (paneId: string) => {
      const pane = getPane(paneId);
      if (!pane) return [];
      const section = getSection(pane.section);
      // Section keywords stay out: they describe the whole section, and would
      // match every row in it. Section matches come from the pane filter.
      return [pane.label, section.label, ...(pane.keywords ?? [])];
    };
    const entries: ResolvedSettingsEntry[] = SETTINGS_ENTRIES.filter(
      (entry) => available.has(entry.pane) && isAvailable(entry, context),
    ).map((entry) => {
      const label = entry.labelKey ? t(entry.labelKey, { defaultValue: entry.label }) : entry.label;
      return {
        id: entry.id,
        // Rows that render in System's Advanced group jump to the pane that hosts it, so
        // native jumps (which land on panes, not rows) reach them.
        pane: (SYSTEM_ADVANCED_SETTINGS as readonly string[]).includes(entry.id)
          ? systemAdvancedHost(context.hasInstallation)
          : entry.pane,
        section: getPane(entry.pane)!.section,
        label,
        hint: entry.hintKey ? t(entry.hintKey, { defaultValue: entry.hint }) : entry.hint,
        // Keep the English label searchable when the interface is translated.
        keywords: label === entry.label ? entry.keywords : [entry.label, ...(entry.keywords ?? [])],
        context: contextFor(entry.pane),
        scope: entry.scope,
        breadcrumb: breadcrumbFor(entry.pane),
      };
    });
    if (available.has("environments.environments")) {
      for (const host of hosts) {
        entries.push({
          id: `environment:${host.serverId}`,
          pane: "environments.environments",
          section: "system",
          label: host.label,
          keywords: ["environment", "host", host.serverId],
          context: contextFor("environments.environments"),
          scope: "device",
          breadcrumb: breadcrumbFor("environments.environments"),
        });
      }
    }
    return entries;
  }, [context, hosts, sections, t]);
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

// Hover is CSS, so the fill clears when the list moves out from under a resting cursor. The
// selected item already wears the hover fill, so it needs no hover entry.

// On web a row's trailing glyph strokes with the row's CSS color, which brightens on hover.
const trailingGlyphColor = (theme: { colors: { foregroundMuted: string } }) =>
  isWeb ? "currentColor" : theme.colors.foregroundMuted;

function getActiveLocale(language: string | undefined): SupportedLocale {
  const parsed = parseAppLanguage(language);
  return parsed && parsed !== "system" ? parsed : "en";
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

interface LanguageSectionProps {
  settings: AppSettings;
  handleLanguageChange: (language: AppLanguage) => void;
}

interface LanguageMenuItemProps {
  value: AppLanguage;
  activeLocale: SupportedLocale;
  selected: boolean;
  onChange: (value: AppLanguage) => void;
}

function LanguageMenuItem({ value, activeLocale, selected, onChange }: LanguageMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  const option = LANGUAGE_OPTIONS.find((entry) => entry.value === value);
  const label = option
    ? formatLanguageOptionLabel(option, activeLocale, t(option.labelKey))
    : value;

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function LanguageSection({ settings, handleLanguageChange }: LanguageSectionProps) {
  const { t, i18n } = useTranslation();
  const activeLocale = getActiveLocale(i18n.language);
  const selectedLanguageOption = LANGUAGE_OPTIONS.find(
    (option) => option.value === settings.language,
  );
  const languageLabel = selectedLanguageOption
    ? formatLanguageOptionLabel(
        selectedLanguageOption,
        activeLocale,
        t(selectedLanguageOption.labelKey),
      )
    : settings.language;
  const resolvedOption = LANGUAGE_OPTIONS.find((option) => option.value === activeLocale);
  const selectedLanguageLabel =
    settings.language === "system" && resolvedOption
      ? `${languageLabel} (${t(resolvedOption.labelKey)})`
      : languageLabel;
  return (
    <SettingsSection title={t("settings.general.language.label")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.language.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.general.language.description")}</Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger accessibilityRole="button" accessibilityLabel={selectedLanguageLabel}>
              {selectedLanguageLabel}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={300}>
              {LANGUAGE_OPTIONS.map((option) => (
                <LanguageMenuItem
                  key={option.value}
                  value={option.value}
                  activeLocale={activeLocale}
                  selected={settings.language === option.value}
                  onChange={handleLanguageChange}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </SettingsSection>
  );
}

interface DiagnosticsRowsProps {
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  handlePlaybackTest: () => Promise<void>;
  /** Separates the first row from rows above it in the shared card. */
  showTopBorder: boolean;
}

/** This device's diagnostic rows, rendered inside the Connected hosts card. */
function DiagnosticsRows({
  voiceAudioEngine,
  isPlaybackTestRunning,
  playbackTestResult,
  handlePlaybackTest,
  showTopBorder,
}: DiagnosticsRowsProps) {
  const { t } = useTranslation();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const handlePlayPress = useCallback(() => {
    void handlePlaybackTest();
  }, [handlePlaybackTest]);
  const firstRowStyle = [settingsStyles.row, showTopBorder && settingsStyles.rowBorder];
  return (
    <>
      <View style={firstRowStyle} testID="app-diagnostic-row">
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.app.rowTitle")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.diagnostics.app.rowHint")}</Text>
        </View>
        <Button variant="secondary" size="sm" onPress={openAppDiagnostic}>
          {t("settings.diagnostics.app.run")}
        </Button>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.testAudio")}</Text>
          {playbackTestResult ? (
            <Text style={settingsStyles.rowHint}>{playbackTestResult}</Text>
          ) : null}
        </View>
        <Button
          variant="secondary"
          size="sm"
          onPress={handlePlayPress}
          disabled={!voiceAudioEngine || isPlaybackTestRunning}
        >
          {isPlaybackTestRunning
            ? t("settings.diagnostics.playing")
            : t("settings.diagnostics.playTest")}
        </Button>
      </View>
    </>
  );
}

function LegacyTerminalRow({ context }: { context: PaneContext }) {
  const { t } = useTranslation();
  return (
    <SettingsSection title="Renderer">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row} testID="legacy-terminal-renderer-row">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.diagnostics.legacyTerminalRenderer.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.diagnostics.legacyTerminalRenderer.description")}
            </Text>
          </View>
          <Switch
            value={context.settings.useLegacyTerminalRenderer}
            onValueChange={context.onUseLegacyTerminalRendererChange}
            accessibilityLabel={t("settings.diagnostics.legacyTerminalRenderer.accessibilityLabel")}
            testID="legacy-terminal-renderer-switch"
          />
        </View>
      </View>
    </SettingsSection>
  );
}

interface AboutSectionProps {
  appVersionText: string;
}

function AboutSection({ appVersionText }: AboutSectionProps) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("settings.about.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.about.appVersion")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.about.thisDevice")}</Text>
          </View>
          <Text style={styles.aboutValue}>{appVersionText}</Text>
        </View>
        <WhatsNewRow />
        <GitHubRow />
      </View>
    </SettingsSection>
  );
}

function openGitHub() {
  void openExternalUrl(VORTEO_GITHUB_URL);
}

function GitHubRow() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();

  return (
    <Pressable
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.trailingGlyphTint]}
      onPress={openGitHub}
      accessibilityRole="link"
      testID="settings-github"
    >
      <View style={styles.githubTitle}>
        <GitHubIcon color={theme.colors.foreground} size={theme.iconSize.sm} />
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.about.github")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.about.githubHint")}</Text>
        </View>
      </View>
      <ExternalLink size={theme.iconSize.sm} color={trailingGlyphColor(theme)} />
    </Pressable>
  );
}

function WhatsNewRow() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();

  return (
    <Pressable
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.trailingGlyphTint]}
      onPress={openChangelog}
      accessibilityRole="button"
      testID="settings-whats-new"
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("changelog.title")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.about.whatsNewHint")}</Text>
      </View>
      <ChevronRight size={theme.iconSize.sm} color={trailingGlyphColor(theme)} />
    </Pressable>
  );
}

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

/** Each host's daemon version, as this device sees it. */
function ConnectedHostsSection({ context }: { context: PaneContext }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  if (hosts.length === 0) return null;
  return (
    <SettingsSection
      title={t("settings.about.connectedHosts")}
      info="Host versions for each environment. Diagnostics are under Advanced at the end of System."
    >
      <View style={settingsStyles.card}>
        {hosts.map((host, index) => (
          <HostVersionRow
            key={host.serverId}
            host={host}
            showBorder={index > 0}
            clientVersion={context.appVersion}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

/** This device's diagnostics, inside System's Advanced group. */
function DiagnosticsSection({ context }: { context: PaneContext }) {
  return (
    <SettingsSection title="Diagnostics">
      <View style={settingsStyles.card}>
        <DiagnosticsRows
          voiceAudioEngine={context.voiceAudioEngine}
          isPlaybackTestRunning={context.isPlaybackTestRunning}
          playbackTestResult={context.playbackTestResult}
          handlePlaybackTest={context.onPlaybackTest}
          showTopBorder={false}
        />
      </View>
    </SettingsSection>
  );
}

/**
 * System's single Advanced group: device diagnostics, plus Installation controls when there is
 * an installation. It renders at the end of whichever of the two panes comes last, and opens
 * for jumps and search hits in either.
 */
const SYSTEM_ADVANCED_PANES = ["general.hosts", "maintenance.installation"] as const;
// System overview rows that live in the group rather than in the overview itself.
const SYSTEM_ADVANCED_SETTINGS = [
  "system.overview.customDomain",
  "system.overview.domain",
  "maintenance.installation.deliveryMode",
  "maintenance.upstream.merge",
] as const;
function SystemAdvancedGroup({
  context,
  installationControls,
}: {
  context: PaneContext;
  installationControls: boolean;
}) {
  return (
    <SettingsAdvancedGroup
      panes={SYSTEM_ADVANCED_PANES}
      settingIds={SYSTEM_ADVANCED_SETTINGS}
      testID="settings-system-advanced"
    >
      {/* Domain, live development and upstream merges, formerly behind System's own toggle. */}
      <InstallationSystemAdvanced />
      <SettingsSection title="Installation overview">
        <Text selectable style={settingsStyles.rowHint}>
          Read-only projects, workspaces and agents across Host and Dev are available at
          /api/installation/overview. Scripts need a dedicated observer credential issued by Host.
        </Text>
      </SettingsSection>
      <UpstreamUpdatesSection />
      {installationControls ? (
        <>
          <InstallationControls requestId={context.restartRequestId} />
          <SystemProjectCard />
        </>
      ) : null}
      <DiagnosticsSection context={context} />
    </SettingsAdvancedGroup>
  );
}

function HostVersionRow({
  host,
  showBorder,
  clientVersion,
}: {
  host: HostProfile;
  showBorder: boolean;
  clientVersion: string | null;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );

  const normalizedHost = normalizeVersion(daemonVersion);
  const normalizedClient = normalizeVersion(clientVersion);
  const isMismatch =
    normalizedHost !== null && normalizedClient !== null && normalizedHost !== normalizedClient;

  let valueText: string;
  if (!isConnected) {
    valueText = t("settings.about.offline");
  } else if (normalizedHost) {
    valueText = formatVersionWithPrefix(normalizedHost);
  } else {
    valueText = "—";
  }

  const valueStyle = useMemo(
    () => [styles.aboutValue, isMismatch && styles.aboutVersionMismatch],
    [isMismatch],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {host.label}
        </Text>
        {isMismatch ? (
          <Text style={settingsStyles.rowHint}>{t("settings.about.versionDiffers")}</Text>
        ) : null}
      </View>
      <Text style={valueStyle} testID={`settings-host-version-${host.serverId}`}>
        {valueText}
      </Text>
    </View>
  );
}

interface SidebarSectionButtonProps {
  sectionId: SettingsSectionId;
  label: string;
  icon: IconComponent;
  isSelected: boolean;
  onSelect: (section: SettingsSectionId) => void;
}

const SIDEBAR_ICON_STROKE_WIDTH = 1.5;

function SidebarSectionButton({
  sectionId,
  label,
  icon: Icon,
  isSelected,
  onSelect,
}: SidebarSectionButtonProps) {
  const { theme } = useUnistyles();
  const compact = useIsCompactFormFactor();
  const itemStyle = useMemo(
    () => [
      isSelected
        ? [sidebarStyles.item, sidebarStyles.itemSelected]
        : [sidebarStyles.item, sidebarStyles.itemHoverable],
      compact && sidebarStyles.touchItem,
    ],
    [compact, isSelected],
  );
  const handlePress = useCallback(() => {
    onSelect(sectionId);
  }, [onSelect, sectionId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  // React Native Web drops `accessibilityState.selected`; the current section is announced by
  // `aria-current` instead.
  const webCurrent = useMemo(
    () => (isWeb && isSelected ? ({ "aria-current": "location" } as const) : null),
    [isSelected],
  );
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  return (
    <Pressable
      {...webCurrent}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      testID={`settings-section-${sectionId}`}
      style={itemStyle}
    >
      <Icon
        size={theme.iconSize.md}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface SettingsSidebarProps {
  sections: readonly SettingsPageSection[];
  selectedSection: SettingsSectionId | null;
  onSelectSection: (section: SettingsSectionId) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  search: SettingsSearchControls;
  layout: "desktop" | "mobile";
}

function SettingsSidebar({
  sections,
  selectedSection,
  onSelectSection,
  onAddHost,
  onBackToWorkspace,
  search,
  layout,
}: SettingsSidebarProps) {
  const { checkNow } = useVortonUpdate();
  // The version footer checks for updates and shows the result where update
  // status lives, in Maintenance.
  const openUpdates = useCallback(() => {
    checkNow();
    onSelectSection("system");
  }, [onSelectSection, checkNow]);
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const hasHosts = hosts.length > 0;
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  const insets = useSafeAreaInsets();
  const isDesktop = layout === "desktop";
  // Settings keeps its own narrow width instead of following the workspace sidebar's, which
  // the owner sizes for long workspace names. The split layout reserves this width.
  const outerContainerStyle = useMemo(
    () => [
      isDesktop && floatingPanelStyles.surface,
      isDesktop && sidebarStyles.floatingContainer,
      isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer,
    ],
    [isDesktop],
  );
  const innerContainerStyle = useMemo(
    () => [{ flex: 1 }, isDesktop ? { paddingTop: insets.top } : null],
    [insets.top, isDesktop],
  );

  const sidebarBody = (
    <View style={sidebarStyles.list}>
      {/* The owner lock sits first, above This device, centered across the sidebar. */}
      <View style={sidebarStyles.ownerSlot} testID="settings-owner-slot">
        <OwnerLockBadge />
      </View>
      <View {...navigationProps(t("settings.title"))}>
        {(["This device", "Vorteo"] as const).map((group) => (
          <View key={group}>
            <Text {...sidebarGroupHeading} style={sidebarStyles.groupLabel} numberOfLines={1}>
              {t(SETTINGS_GROUP_LABEL_KEYS[group])}
            </Text>
            <View {...listProps}>
              {sections
                .filter((section) => getSection(section.id).group === group)
                .map((section) => (
                  <View key={section.id} {...listItemProps}>
                    <SidebarSectionButton
                      sectionId={section.id}
                      label={section.label}
                      icon={SECTION_ICONS[section.id]}
                      isSelected={selectedSection === section.id}
                      onSelect={onSelectSection}
                    />
                  </View>
                ))}
            </View>
          </View>
        ))}
      </View>
      {hasHosts ? null : (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.addHost")}
            onPress={onAddHost}
            testID="settings-add-host"
            style={[sidebarStyles.item, sidebarStyles.itemHoverable]}
          >
            <Plus
              size={theme.iconSize.md}
              color={theme.colors.foregroundMuted}
              strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
            />
            <Text style={sidebarStyles.label} numberOfLines={1}>
              {t("settings.addHost")}
            </Text>
          </Pressable>
          {enableBuiltInDaemonOption.visible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.enableBuiltInDaemon")}
              onPress={enableBuiltInDaemonOption.onPress}
              testID="settings-enable-built-in-daemon"
              style={[sidebarStyles.item, sidebarStyles.itemHoverable]}
            >
              <Server
                size={theme.iconSize.md}
                color={theme.colors.foregroundMuted}
                strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
              />
              <Text style={sidebarStyles.label} numberOfLines={1}>
                {t("settings.enableBuiltInDaemon")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );

  return (
    <View style={outerContainerStyle} testID="settings-sidebar">
      {isDesktop ? (
        <View style={innerContainerStyle}>
          <View style={sidebarStyles.sidebarDragArea}>
            <TitlebarDragRegion />
            <WindowChromeSafeArea placement="below" />
            {/* Back and search share one height and sit the same distance from either edge. */}
            <View style={sidebarStyles.modeHeader} testID="settings-mode-header">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={ArrowLeft}
                onPress={onBackToWorkspace}
                testID="settings-back-to-workspace"
                style={sidebarStyles.backButton}
                accessibilityLabel={t("settings.backToWorkspace")}
              >
                {t("common.back")}
              </Button>
              <View {...searchLandmarkProps} style={sidebarStyles.search}>
                <SettingsSearchBox search={search} compact />
              </View>
            </View>
          </View>
          <ScrollView
            style={sidebarStyles.scrollBody}
            showsVerticalScrollIndicator={false}
            testID="settings-sidebar-scroll-body"
          >
            {sidebarBody}
          </ScrollView>
          <InstallationRestartBanner placement="sidebar" />
          <SidebarIdentityFooter
            onOpenUpdates={openUpdates}
            versionTestID="settings-sidebar-version"
          />
        </View>
      ) : (
        sidebarBody
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

/** What pane bodies need from the settings screen. */
interface PaneContext {
  appVersion: string | null;
  appVersionText: string;
  isDesktopApp: boolean;
  settings: AppSettings;
  restartRequestId: string | null;
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  onAddHost: () => void;
  onHostRemoved: () => void;
  onLanguageChange: (language: AppLanguage) => void;
  onPlaybackTest: () => Promise<void>;
  onUseLegacyTerminalRendererChange: (value: boolean) => void;
  onOpenPane: (paneId: string) => void;
  onJump: (target: SettingsJumpTarget) => void;
  onOpenShortcuts: () => void;
  /** Whether Installation controls render, which decides where System's Advanced group goes. */
  hasInstallation: boolean;
}

type InstallationPaneSection = Parameters<typeof InstallationSettingsContent>[0]["section"];

/**
 * Voice settings live on the Host daemon: the installation's Host when there is one,
 * otherwise the first saved host, the same rule the other host-backed panes use.
 */
function VoicePane() {
  const hosts = useHosts();
  const installation = readExecutionInstallation();
  const authority = installation?.environments.find((environment) => environment.kind === "host");
  const serverId = authority?.serverId ?? hosts[0]?.serverId;
  return serverId ? <HostVoicePage serverId={serverId} /> : null;
}

function installationPane(section: InstallationPaneSection) {
  return (context: PaneContext) => (
    <InstallationSettingsContent section={section} onAddHost={context.onAddHost} />
  );
}

const DESKTOP_ADVANCED_PANES = ["agents.browserData", "agents.permissions"] as const;

/**
 * The panes that host matching rows for a search: Browser data renders in Permissions, and
 * System's Advanced group (diagnostics, installation controls, domain, live development and
 * upstream rows) renders in Installation controls with an installation, otherwise in
 * Connected hosts.
 */
/** The pane that renders System's Advanced group. */
function systemAdvancedHost(hasInstallation: boolean): string {
  return hasInstallation ? "maintenance.installation" : "general.hosts";
}

function advancedHostPanes(
  panes: ReadonlySet<string>,
  entryIds: ReadonlySet<string>,
  hasInstallation: boolean,
): Set<string> {
  const hosts = new Set<string>();
  if (panes.has("agents.browserData")) hosts.add("agents.permissions");
  const systemHit =
    panes.has("general.hosts") ||
    panes.has("maintenance.installation") ||
    SYSTEM_ADVANCED_SETTINGS.some((id) => entryIds.has(id));
  if (systemHit) hosts.add(systemAdvancedHost(hasInstallation));
  return hosts;
}

// One stable Reset per device group, so pane renders do not remount its button.
const RESET_BUTTONS = Object.fromEntries(
  (["chat", "sending", "openLocation", "editor", "files", "terminal"] as const).map((group) => [
    group,
    <ResetGroupButton key={group} group={group} />,
  ]),
) as Partial<Record<SettingsResetGroup, ReactNode>>;

/**
 * Puts a device group's Reset in the header of the pane's section. These pane components render
 * one section each, which takes the button as its header action.
 */
function withReset(group: SettingsResetGroup, pane: ReactNode): ReactNode {
  return (
    <SettingsSectionTrailing.Provider value={RESET_BUTTONS[group]}>
      {pane}
    </SettingsSectionTrailing.Provider>
  );
}

/** Each catalog pane's body. Panes reuse the existing settings components. */
const PANE_RENDERERS: Record<string, (context: PaneContext) => ReactNode> = {
  "general.notifications": () => <DesktopNotificationsSection />,
  "general.installation": () => <InstallationNameSection />,
  "general.about": (context) => (
    <>
      <AboutSection appVersionText={context.appVersionText} />
      <HelpSection />
    </>
  ),
  "general.hosts": (context) => (
    <>
      <ConnectedHostsSection context={context} />
      {context.hasInstallation ? null : (
        <SystemAdvancedGroup context={context} installationControls={false} />
      )}
    </>
  ),
  "accounts.providers": installationPane("providers"),
  "accounts.profiles": installationPane("profiles"),
  "accounts.usage": installationPane("usage"),
  "agents.tools": installationPane("agents"),
  "agents.skills": () => <SkillLibraryContent />,
  "voice.voice": () => <VoicePane />,
  "agents.metadata": (context) => (
    <SettingsAdvancedGroup testID="settings-agents-advanced">
      {installationPane("metadata")(context)}
    </SettingsAdvancedGroup>
  ),
  // Browser data and Permissions are desktop-only and rarely changed, so they share one
  // Advanced group at the end of Interface, rendered from the later of the two panes.
  "agents.browserData": () => null,
  "agents.permissions": () => (
    <SettingsAdvancedGroup panes={DESKTOP_ADVANCED_PANES} testID="settings-interface-advanced">
      <BrowserDataSection />
      <DesktopPermissionsSection />
    </SettingsAdvancedGroup>
  ),
  "chat.chat": () => withReset("chat", <ChatSection />),
  "chat.sending": () => withReset("sending", <SendingSection />),
  "chat.openLocation": () => withReset("openLocation", <OpenLocationSection />),
  "chat.editor": () => withReset("editor", <EditorSection />),
  "chat.files": () => withReset("files", <FilesSection />),
  "chat.shortcuts": (context) => (
    <SettingsSection title="Keyboard">
      <SettingsCard>
        <SettingsDetailRow
          label="Keyboard shortcuts"
          hint="View and customize shortcuts"
          onPress={context.onOpenShortcuts}
          testID="settings-keyboard-shortcuts"
        />
      </SettingsCard>
    </SettingsSection>
  ),
  "terminal.terminal": (context) => (
    <>
      {withReset("terminal", <TerminalSection />)}
      {isNative ? (
        <SettingsAdvancedGroup testID="settings-terminal-advanced">
          <LegacyTerminalRow context={context} />
        </SettingsAdvancedGroup>
      ) : null}
    </>
  ),
  "terminal.profiles": installationPane("terminals"),
  "appearance.appearance": () => <AppearanceSection />,
  "appearance.sidebar": () => <SidebarNavSection />,
  "appearance.language": (context) => (
    <LanguageSection settings={context.settings} handleLanguageChange={context.onLanguageChange} />
  ),
  "workspaces.newWorkspace": () => <WorkspaceDefaultsSection />,
  // The project list is a bare card; the heading gives it the same rhythm as every other pane.
  "workspaces.projects": (context) => (
    <SettingsSection title="Projects">{installationPane("projects")(context)}</SettingsSection>
  ),
  "workspaces.workspaces": installationPane("workspaces"),
  // A group inside System: its heading sits over the environment rows and the Connections
  // pane right after them, spaced like sections so the two read as one group.
  "environments.environments": (context) => (
    <SettingsGroup
      title="Environments"
      style={settingsStyles.section}
      testID="settings-environments-group"
    >
      <EnvironmentsPane onHostRemoved={context.onHostRemoved} />
    </SettingsGroup>
  ),
  "environments.connections": installationPane("connections"),
  "plugins.plugins": installationPane("plugins"),
  "plugins.integrations": () => <IntegrationsSection />,
  "maintenance.installation": (context) => (
    <SystemAdvancedGroup context={context} installationControls />
  ),
  "system.health": (context) => <SystemHealthSection onFix={context.onJump} />,
  // One view of Host and Dev status, restarts, updates and their technical details.
  "system.overview": (context) => <SystemPane restartRequestId={context.restartRequestId} />,
};

// ---------------------------------------------------------------------------
// Drill-in pages
// ---------------------------------------------------------------------------

function resolveDetailTitle(
  view: SettingsView,
  installedPlugins: ReturnType<typeof useInstalledPlugins>,
  t: TFunction,
): string | undefined {
  if (view.kind === "plugin") {
    const screen = installedPlugins
      .find((plugin) => plugin.serverId === view.serverId && plugin.id === view.pluginId)
      ?.settingsScreens.find((candidate) => candidate.id === view.screenId);
    return `${view.pluginId} · ${screen?.title ?? t("settings.title")}`;
  }
  if (view.kind === "project") return t("settings.projects");
  return undefined;
}

function renderDetailContent(
  view: SettingsView,
  options: {
    isCompactLayout: boolean;
    onBack: () => void;
  },
): ReactNode {
  if (view.kind === "plugin") {
    return (
      <PluginSettingsContent
        serverId={view.serverId}
        pluginId={view.pluginId}
        screenId={view.screenId}
        onBackToPlugins={options.onBack}
        showBackToPlugins={!options.isCompactLayout}
      />
    );
  }
  if (view.kind === "project") {
    return (
      <ProjectSettingsScreen
        serverId={view.serverId}
        projectId={view.projectId}
        onBackToProjects={options.onBack}
        showBackToProjects={!options.isCompactLayout}
      />
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: SettingsView;
  installationRequested?: boolean;
  restartRequestId?: string | null;
  /** Catalog entry id to scroll to and highlight, from `?setting=`. */
  settingId?: string | null;
}

function showsSettingsPage(view: SettingsView, shortcutsOpen: boolean, searching: boolean) {
  return (view.kind === "section" && !shortcutsOpen) || searching;
}

/**
 * While this page is in front and showing its sections, outside controls such as "System needs
 * attention" jump here instead of pushing another settings page over it.
 */
function useSettingsJumpListener(
  page: { view: SettingsView; shortcutsOpen: boolean; searching: boolean; loading: boolean },
  jumpTo: (target: SettingsJumpTarget) => void,
) {
  const enabled =
    !page.loading &&
    page.view.kind === "section" &&
    showsSettingsPage(page.view, page.shortcutsOpen, page.searching);
  useFocusEffect(
    useCallback(() => (enabled ? registerSettingsJump(jumpTo) : undefined), [enabled, jumpTo]),
  );
}

export default function SettingsScreen({
  view,
  installationRequested = false,
  restartRequestId = null,
  settingId = null,
}: SettingsScreenProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);
  const isDesktopApp = isElectronRuntime();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const isCompactLayout = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const insetBottomStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);

  const availability = useAvailabilityContext();
  const sections = useSettingsSections(availability);
  const entries = useSearchEntries(sections, availability);
  const navigation = useSettingsNavigation({
    view,
    installationRequested,
    restartRequestId,
    settingId,
    isCompactLayout,
    hasInstallation: availability.hasInstallation,
    sections,
    entries,
  });
  const {
    query,
    search,
    results,
    request,
    activeSection,
    handleSelectSection,
    handleSelectResult,
  } = navigation;
  const selectSection = useCallback(
    (section: SettingsSectionId) => {
      closeShortcuts();
      handleSelectSection(section);
    },
    [closeShortcuts, handleSelectSection],
  );
  const selectResult = useCallback(
    (entry: ResolvedSettingsEntry) => {
      closeShortcuts();
      handleSelectResult(entry);
    },
    [closeShortcuts, handleSelectResult],
  );
  const headerSearch = useMemo(
    () =>
      isCompactLayout ? (
        <View style={styles.headerSearch} testID="settings-header-search">
          <SettingsSearchBox search={search} fitPlaceholder />
        </View>
      ) : undefined,
    [isCompactLayout, search],
  );
  useSettingsSearchShortcut();
  const searching = query.trim().length > 0;

  const handleLanguageChange = useCallback(
    (language: AppLanguage) => {
      void updateSettings({ language });
    },
    [updateSettings],
  );

  const handleUseLegacyTerminalRendererChange = useCallback(
    (useLegacyTerminalRenderer: boolean) => {
      void updateSettings({ useLegacyTerminalRenderer });
    },
    [updateSettings],
  );

  const handlePlaybackTest = useCallback(async () => {
    if (!voiceAudioEngine || isPlaybackTestRunning) {
      return;
    }

    setIsPlaybackTestRunning(true);
    setPlaybackTestResult(null);

    try {
      const bytes = Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64");
      await voiceAudioEngine.initialize();
      voiceAudioEngine.stop();
      await voiceAudioEngine.play({
        type: "audio/pcm;rate=16000;bits=16",
        size: bytes.byteLength,
        async arrayBuffer() {
          return Uint8Array.from(bytes).buffer;
        },
      });
      setPlaybackTestResult(null);
    } catch (error) {
      console.error("[Settings] Playback test failed", error);
      setPlaybackTestResult(
        t("settings.diagnostics.playbackFailed", { message: toErrorMessage(error) }),
      );
    } finally {
      setIsPlaybackTestRunning(false);
    }
  }, [isPlaybackTestRunning, t, voiceAudioEngine]);

  const handleHostAdded = useCallback(
    (serverId: string) => {
      selectSettingsHost(serverId);
      const target = buildSettingsHostSectionRoute(serverId, "host");
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleAddHost = useAddHost({ onAdded: handleHostAdded });

  const handleHostRemoved = useCallback(() => {
    if (isCompactLayout) {
      router.replace("/settings");
    } else {
      router.replace(buildSettingsSectionRoute("general"));
    }
  }, [isCompactLayout, router]);

  const handleBackFromDetail = useCallback(() => {
    returnFromSettings(view);
  }, [view]);

  const handleBackToWorkspace = useCallback(() => {
    returnFromSettings({ kind: "root" });
  }, []);

  const paneContext = useMemo<PaneContext>(
    () => ({
      appVersion,
      appVersionText,
      isDesktopApp,
      settings,
      restartRequestId,
      voiceAudioEngine,
      isPlaybackTestRunning,
      playbackTestResult,
      onAddHost: handleAddHost,
      onHostRemoved: handleHostRemoved,
      onLanguageChange: handleLanguageChange,
      onPlaybackTest: handlePlaybackTest,
      onUseLegacyTerminalRendererChange: handleUseLegacyTerminalRendererChange,
      onOpenPane: navigation.openPane,
      onJump: navigation.jumpTo,
      onOpenShortcuts: openShortcuts,
      hasInstallation: availability.hasInstallation,
    }),
    [
      appVersion,
      appVersionText,
      handleAddHost,
      handleHostRemoved,
      handleLanguageChange,
      handlePlaybackTest,
      handleUseLegacyTerminalRendererChange,
      isDesktopApp,
      isPlaybackTestRunning,
      navigation.openPane,
      navigation.jumpTo,
      availability.hasInstallation,
      openShortcuts,
      playbackTestResult,
      restartRequestId,
      settings,
      voiceAudioEngine,
    ],
  );
  // The ruled This device and Vorteo headings say where a setting applies, so panes carry no
  // per-header scope label, and Advanced panes render their own disclosure.
  // Advanced groups that render rows indexed under another pane keep their host pane visible
  // when those rows match a search.
  const hasInstallation = availability.hasInstallation;
  const searchHostPanes = useCallback(
    (panes: ReadonlySet<string>, entryIds: ReadonlySet<string>) =>
      advancedHostPanes(panes, entryIds, hasInstallation),
    [hasInstallation],
  );
  const groupLabel = useCallback(
    (group: SettingsGroupName) => t(SETTINGS_GROUP_LABEL_KEYS[group]),
    [t],
  );
  const renderPane = useCallback(
    (paneId: string): ReactNode => PANE_RENDERERS[paneId]?.(paneContext) ?? null,
    [paneContext],
  );

  useSettingsJumpListener(
    { view, shortcutsOpen, searching, loading: settingsLoading },
    navigation.jumpTo,
  );

  const installedPlugins = useInstalledPlugins();
  const detailTitle = resolveDetailTitle(view, installedPlugins, t);
  const detailContent = renderDetailContent(view, {
    isCompactLayout,
    onBack: handleBackFromDetail,
  });
  const focus = view.kind === "section" ? (view.focus ?? null) : null;

  if (settingsLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t("settings.loading")}</Text>
      </View>
    );
  }

  const scrollPage = (
    <SettingsFocusContext.Provider value={focus}>
      <SettingsScrollPage
        sections={sections}
        renderPane={renderPane}
        request={request}
        onActiveSectionChange={navigation.handleActiveSectionChange}
        query={query}
        results={results}
        matchedPanes={navigation.matchedPanes}
        selectedResult={navigation.selectedResult}
        onSelectResult={selectResult}
        bottomInset={insets.bottom}
        groupLabel={groupLabel}
        searchHostPanes={searchHostPanes}
      />
    </SettingsFocusContext.Provider>
  );

  const showScrollPage = showsSettingsPage(view, shortcutsOpen, searching);
  const activeLabel = sections.find((section) => section.id === activeSection)?.label;
  const detailPage = showScrollPage ? (
    <View style={styles.container}>
      {isCompactLayout ? (
        <BackHeader
          title={view.kind === "section" && !searching ? activeLabel : t("settings.title")}
          onBack={view.kind === "section" ? handleBackFromDetail : handleBackToWorkspace}
          rightContent={headerSearch}
        />
      ) : (
        // The sidebar owns the top-left corner, so a desktop header would hold nothing but
        // height. Reserve space only where window controls overlap the page, and keep the drag
        // region over that space.
        <View style={desktopStyles.chrome}>
          <TitlebarDragRegion />
          <WindowChromeSafeArea placement="below" />
        </View>
      )}
      {scrollPage}
    </View>
  ) : (
    <PageLayout
      title={shortcutsOpen ? "Keyboard shortcuts" : detailTitle}
      actions={headerSearch}
      titleTestID="settings-detail-header-title"
      onBack={shortcutsOpen ? closeShortcuts : handleBackFromDetail}
    >
      {shortcutsOpen ? <KeyboardShortcutsSection /> : detailContent}
    </PageLayout>
  );

  const selectedSection = selectedSidebarSection(view, searching, activeSection);

  // Keep the phone header mounted while results replace the index, preserving input focus.
  if (isCompactLayout && view.kind === "root") {
    return (
      <SettingsCloseGesture onClose={handleBackToWorkspace}>
        <View style={styles.container}>
          <BackHeader
            title={t("settings.title")}
            onBack={handleBackToWorkspace}
            rightContent={headerSearch}
          />
          {searching ? (
            scrollPage
          ) : (
            <ScrollView
              style={styles.scrollView}
              contentContainerStyle={insetBottomStyle}
              keyboardShouldPersistTaps="handled"
            >
              <SettingsSidebar
                sections={sections}
                selectedSection={null}
                onSelectSection={selectSection}
                onAddHost={handleAddHost}
                onBackToWorkspace={handleBackToWorkspace}
                search={search}
                layout="mobile"
              />
            </ScrollView>
          )}
        </View>
      </SettingsCloseGesture>
    );
  }

  if (isCompactLayout) {
    return (
      <SettingsCloseGesture onClose={handleBackToWorkspace}>
        <View {...mainLandmarkProps} style={styles.container}>
          {detailPage}
        </View>
      </SettingsCloseGesture>
    );
  }

  // Desktop split view — mirrors AppContainer: sidebar owns the titlebar drag
  // region + traffic-light padding; detail pane renders whatever header the
  // selected section provides.
  return (
    <View style={styles.container}>
      <View style={desktopStyles.row}>
        <WindowChromeRegion corners="top-left">
          <SettingsSidebar
            sections={sections}
            selectedSection={selectedSection}
            onSelectSection={selectSection}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            search={search}
            layout="desktop"
          />
        </WindowChromeRegion>
        <WindowChromeRegion corners="top-right">
          <View
            {...mainLandmarkProps}
            style={desktopStyles.contentPane}
            testID="settings-detail-pane"
          >
            {detailPage}
          </View>
        </WindowChromeRegion>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  aboutInstallation: { marginBottom: theme.spacing[3] },
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  aboutVersionMismatch: {
    color: theme.colors.palette.amber[500],
  },
  aboutErrorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  trailingGlyphTint: hoverStyle(
    { color: theme.colors.foreground },
    { color: theme.colors.foregroundMuted },
  ),
  githubTitle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  headerSearch: {
    height: FLOATING_PANEL_CONTROL_HEIGHT,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  aboutUpdateActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

// Landmarks: the section list is navigation, the search field a search region and the page main.
// React Native Web renders `role`; native has no landmark equivalent.
const mainLandmarkProps = isWeb ? ({ role: "main" } as const) : {};
// React Native's Role type lacks "search"; react-native-web passes it through.
const searchLandmarkProps: object = isWeb ? { role: "search" } : {};
const listProps = isWeb ? ({ role: "list" } as const) : {};
const listItemProps = isWeb ? ({ role: "listitem" } as const) : {};
function navigationProps(label: string) {
  return isWeb ? ({ role: "navigation", "aria-label": label } as const) : {};
}
// Sidebar group labels name the lists under them, one level below the page.
const sidebarGroupHeading = isWeb
  ? ({ accessibilityRole: "header", "aria-level": 2 } as const)
  : ({ accessibilityRole: "header" } as const);

const desktopStyles = StyleSheet.create({
  chrome: { position: "relative" },
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
  },
});

const sidebarStyles = StyleSheet.create((theme) => ({
  floatingContainer: {
    margin: FLOATING_PANEL_INSET,
    overflow: "hidden",
  },
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH - FLOATING_PANEL_INSET * 2,
  },
  scrollBody: {
    flex: 1,
    // Font changes must preserve the sidebar offset, not anchor its group headings.
    ...(isWeb ? { overflowAnchor: "none" as const } : {}),
  },
  // Fills what Back leaves, so the field is as wide as the row allows.
  search: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    marginLeft: theme.spacing[2],
  },
  ownerSlot: { paddingTop: theme.spacing[1] },
  modeHeader: {
    height: VORTON_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    flexShrink: 0,
    minWidth: 0,
    justifyContent: "flex-start",
    borderRadius: SIDEBAR_CONTROL_HEIGHT / 2,
    height: SIDEBAR_CONTROL_HEIGHT,
    minHeight: SIDEBAR_CONTROL_HEIGHT,
    paddingHorizontal: theme.spacing[2],
  },
  sidebarDragArea: {
    position: "relative",
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  list: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[0.5],
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  touchItem: { minHeight: 44 },
  itemHoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
  // Distinct from hover, so the current section reads as current, not as under the pointer.
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
  label: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  pickerTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  // Match the setting items' icon footprint so the host label aligns with them.
  pickerTriggerDot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
