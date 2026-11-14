import { CardHeaderStatus } from "@/components/ui/card-header-status";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExternalLink, type ExternalLinkProps } from "@/components/ui/external-link";
import { SettingsInfoTip } from "./settings-info-tip";
import { SettingsHeadingLevel, useSettingsHeadingLevel, webHeadingLevel } from "./heading-level";
import { settingsStyles } from "@/styles/settings";

/**
 * A header action the settings page supplies for a pane whose component it does not own, such as
 * the pane's Reset. A section with its own `trailing` keeps it; sections nested inside a section's
 * content never inherit it.
 */
export const SettingsSectionTrailing = createContext<ReactNode>(null);

interface SettingsSectionProps {
  title: string;
  /**
   * What this section is for. Renders as an info tooltip on the header; a
   * paragraph between the header and the card is wrong (docs/design.md §7).
   */
  info?: ReactNode;
  /**
   * A page outside the app, such as the docs, shown at the header's end as "Label ↗". Its glyph
   * sits as far inside the card's edge as the title does on the other side.
   */
  link?: Pick<ExternalLinkProps, "href" | "label" | "accessibilityLabel" | "tooltip" | "testID">;
  /** An action at the header's end, such as Refresh or Add. A link to a page is `link`. */
  trailing?: ReactNode;
  status?: string | null;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /**
   * Drops the section's bottom margin. Use when the section is the last child
   * of a SettingsGroup, so the group's own bottom margin owns the trailing gap.
   */
  flush?: boolean;
  children: ReactNode;
}

/**
 * iOS-style grouped settings block: muted label + children stacked with a
 * consistent gap. The single primitive used for every section across settings;
 * don't reach for ad-hoc `<Text>` headers or bare card margins.
 */
export function SettingsSection({
  title,
  info,
  link,
  trailing,
  status,
  testID,
  style,
  flush,
  children,
}: SettingsSectionProps) {
  const inheritedTrailing = useContext(SettingsSectionTrailing);
  // This title takes the current level; sections nested in its content take the next.
  const level = useSettingsHeadingLevel();
  const sectionStyle = useMemo(
    () => [settingsStyles.section, flush ? styles.flush : null, style],
    [flush, style],
  );
  return (
    <View style={sectionStyle} testID={testID}>
      <View style={styles.header}>
        <View style={[styles.titleRow, status !== undefined && styles.statusTitle]}>
          {/* One line always: a long title truncates rather than wrapping the header. */}
          <Text
            {...webHeadingLevel(level)}
            accessibilityRole="header"
            style={[settingsStyles.sectionHeaderTitle, styles.title]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {info && status === undefined ? (
            <SettingsInfoTip
              title={title}
              info={info}
              testID={testID ? `${testID}-info` : undefined}
            />
          ) : null}
        </View>
        {status !== undefined ? <CardHeaderStatus text={status} /> : null}
        {info && status !== undefined ? (
          <SettingsInfoTip
            title={title}
            info={info}
            testID={testID ? `${testID}-info` : undefined}
          />
        ) : null}
        {link ? (
          <View style={styles.link}>
            <ExternalLink {...link} />
          </View>
        ) : null}
        {trailing ?? inheritedTrailing}
      </View>
      <SettingsSectionTrailing.Provider value={null}>
        <SettingsHeadingLevel.Provider value={level + 1}>
          <View style={styles.content}>{children}</View>
        </SettingsHeadingLevel.Provider>
      </SettingsSectionTrailing.Provider>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  // Mirrors the header's marginLeft, so the link's glyph and the title's sit on matching rails.
  link: {
    marginRight: theme.spacing[1],
  },
  // Shrinks before the header's trailing controls do, so the header stays on one line.
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  statusTitle: { maxWidth: "65%", flexShrink: 1 },
  title: { flexShrink: 1 },
  content: {
    gap: theme.spacing[2],
  },
  flush: {
    marginBottom: 0,
  },
}));
