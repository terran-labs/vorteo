import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Import as ImportIcon } from "lucide-react-native";
import { composerPillStyles } from "@/composer/pill-styles";
import { groupHoverStyle, hoverGroup, hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";

const ThemedImportIcon = withUnistyles(ImportIcon);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ComposerImportPillProps {
  onPress: () => void;
  disabled?: boolean;
}

export function ComposerImportPill({ onPress, disabled = false }: ComposerImportPillProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      <Pressable
        testID="composer-import-agent-pill"
        accessibilityRole="button"
        accessibilityLabel={t("importSession.title")}
        onPress={onPress}
        disabled={disabled}
        style={disabled ? composerPillStyles.body : BODY_STYLE}
      >
        <ThemedImportIcon size={14} uniProps={iconColorMapping} />
        <Text style={LABEL_STYLE} numberOfLines={1}>
          {t("importSession.title")}
        </Text>
      </Pressable>
    </View>
  );
}

// Browser-owned hover, matching `composerPillStyles.bodyActive` and `labelActive`.
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
  },
  // One `_web` key per style: the group class rides along with the hover fill.
  bodyHoverable: hoverGroup(
    "import-pill",
    hoverStyle({ backgroundColor: theme.colors.surface2 })._web,
  ),
  labelHoverable: groupHoverStyle("import-pill", { color: theme.colors.foreground }),
}));
const BODY_STYLE = [composerPillStyles.body, styles.bodyHoverable];
const LABEL_STYLE = [composerPillStyles.label, styles.labelHoverable];
