import { memo, type ReactElement } from "react";
import { Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import { composerPillStyles } from "@/composer/pill-styles";
import { useVisibleWorkspaceDiffStat } from "@/composer/workspace-diff-stat";
import { hoverStyle } from "@/styles/hover";

interface ComposerDiffStatPillProps {
  additions: number;
  deletions: number;
  onPress: () => void;
}

export function ComposerDiffStatPill({ additions, deletions, onPress }: ComposerDiffStatPillProps) {
  const { t } = useTranslation();

  return (
    <Pressable
      testID="composer-diff-stat-pill"
      accessibilityRole="button"
      accessibilityLabel={t("workspace.git.diff.openChangesTab")}
      onPress={onPress}
      style={BODY_STYLE}
    >
      <DiffStat additions={additions} deletions={deletions} />
    </Pressable>
  );
}

export const WorkspaceDiffStatPill = memo(function WorkspaceDiffStatPill({
  serverId,
  workspaceId,
  onPress,
}: {
  serverId: string;
  workspaceId: string;
  onPress: () => void;
}): ReactElement | null {
  const diffStat = useVisibleWorkspaceDiffStat(serverId, workspaceId);
  if (!diffStat) {
    return null;
  }
  return (
    <ComposerDiffStatPill
      additions={diffStat.additions}
      deletions={diffStat.deletions}
      onPress={onPress}
    />
  );
});

// Browser-owned hover fill, matching `composerPillStyles.bodyActive`.
const styles = StyleSheet.create((theme) => ({
  bodyHoverable: hoverStyle({ backgroundColor: theme.colors.surface2 }),
}));
const BODY_STYLE = [composerPillStyles.body, styles.bodyHoverable];
