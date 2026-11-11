import { useCallback, type ComponentType } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Activity, ChevronRight, ExternalLink, Keyboard } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { hoverStyle } from "@/styles/hover";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const DISCORD_URL = "https://discord.gg/jz8T2uahpH";
const GITHUB_ISSUE_URL = "https://github.com/getpaseo/paseo/issues/new";

interface GlyphProps {
  size?: number;
  color?: string;
}
type Glyph = ComponentType<GlyphProps>;

// On web a row's glyphs stroke with the row's CSS color, which brightens on hover.
const glyphColor = (theme: Theme) => ({
  color: isWeb ? "currentColor" : theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
});
const themed = (icon: Glyph) => withUnistyles(icon, glyphColor);
const ShortcutsGlyph = themed(Keyboard);
const DiagnosticsGlyph = themed(Activity);
const DiscordGlyph = themed(DiscordIcon);
const GitHubGlyph = themed(GitHubIcon);
const OpensGlyph = themed(ChevronRight);
const ExternalGlyph = themed(ExternalLink);

/**
 * Help, moved from the sidebar's former Help and support menu: keyboard shortcuts, diagnostics
 * and the two places to report an issue. Versions and What's new live in About above it.
 */
export function HelpSection() {
  const { t } = useTranslation();
  const shortcutsAvailable = useHardwareKeyboardPresent();
  const openDiagnostics = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const openShortcuts = useCallback(() => setShortcutsDialogOpen(true), [setShortcutsDialogOpen]);
  const openDiscord = useCallback(() => void openExternalUrl(DISCORD_URL), []);
  const openGitHubIssue = useCallback(() => void openExternalUrl(GITHUB_ISSUE_URL), []);
  return (
    <SettingsSection title={t("sidebar.help.sectionHelp")} testID="settings-help">
      {shortcutsAvailable ? (
        <HelpRow
          Icon={ShortcutsGlyph}
          label={t("sidebar.help.shortcuts")}
          onPress={openShortcuts}
          testID="settings-help-shortcuts"
        />
      ) : null}
      <HelpRow
        Icon={DiagnosticsGlyph}
        label={t("sidebar.help.diagnostics")}
        onPress={openDiagnostics}
        testID="settings-help-diagnostics"
      />
      <HelpRow
        Icon={DiscordGlyph}
        label={t("sidebar.help.discord")}
        hint={t("sidebar.help.reportIssue")}
        onPress={openDiscord}
        external
        testID="settings-help-discord"
      />
      <HelpRow
        Icon={GitHubGlyph}
        label={t("sidebar.help.github")}
        hint={t("sidebar.help.reportIssue")}
        onPress={openGitHubIssue}
        external
        testID="settings-help-github"
      />
    </SettingsSection>
  );
}

function HelpRow({
  Icon,
  label,
  hint,
  onPress,
  external = false,
  testID,
}: {
  Icon: Glyph;
  label: string;
  hint?: string;
  onPress: () => void;
  /** Opens a site outside Vorteo: a link role and an external-link glyph. */
  external?: boolean;
  testID: string;
}) {
  const Trailing = external ? ExternalGlyph : OpensGlyph;
  return (
    <PressHighlight
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.rowHover]}
      onPress={onPress}
      accessibilityRole={external ? "link" : "button"}
      accessibilityLabel={label}
      accessibilityHint={hint}
      testID={testID}
    >
      <View style={styles.title}>
        <Icon />
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{label}</Text>
          {hint ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
        </View>
      </View>
      <Trailing />
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  // About's link rows, with the browser-owned hover tint.
  rowHover: hoverStyle({ color: theme.colors.foreground }, { color: theme.colors.foregroundMuted }),
  title: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
}));
