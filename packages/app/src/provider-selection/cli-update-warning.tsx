import type { ProviderCliUpdate } from "@getpaseo/protocol/messages";
import { AlertTriangle } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useMaintenanceTask } from "@/execution-installation/use-maintenance-task";
import { buildCliUpgradePrompt } from "./cli-upgrade-prompt";

const WarningIcon = withUnistyles(AlertTriangle, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.palette.amber[500],
}));

interface CliUpdateWarningProps {
  update: ProviderCliUpdate | undefined;
  /** Environment that reported the outdated CLI, named in the upgrade task. */
  environment?: string;
  /**
   * Render without a border, for a card that already shows the warning border itself.
   */
  embedded?: boolean;
}

export function CliUpdateWarning({ update, environment, embedded }: CliUpdateWarningProps) {
  const prepareTask = useMaintenanceTask();
  const upgrade = useCallback(() => {
    if (update) prepareTask(buildCliUpgradePrompt(update, environment), { inActiveProject: true });
  }, [prepareTask, update, environment]);
  const details = useMemo(() => (update ? <CliUpdateDetails update={update} /> : null), [update]);
  if (!update) return null;
  const title = `${update.cli} update needed`;
  const action = (
    <Button variant="outline" size="md" onPress={upgrade} testID="provider-cli-upgrade">
      {`Upgrade ${update.cli}`}
    </Button>
  );
  if (!embedded) {
    return (
      <Alert variant="warning" title={title} description={details} testID="provider-cli-update">
        {action}
      </Alert>
    );
  }
  return (
    <View style={styles.embedded} testID="provider-cli-update" accessibilityRole="alert">
      <View style={styles.titleRow}>
        <WarningIcon />
        <Text style={styles.title}>{title}</Text>
      </View>
      {details}
      <View style={styles.actions}>{action}</View>
    </View>
  );
}

function CliUpdateDetails({ update }: { update: ProviderCliUpdate }) {
  return (
    <View style={styles.content}>
      <Text style={styles.text}>
        This environment has {update.cli} {update.installedVersion}. These models need a newer CLI:
      </Text>
      {update.affectedModels.map((model) => (
        <Text key={model.id} style={styles.text}>
          {model.label}: {model.minimumVersion} or later
        </Text>
      ))}
      <Text selectable style={styles.text}>
        {update.instructions}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  embedded: { gap: theme.spacing[2] },
  titleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: {
    flex: 1,
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actions: { flexDirection: "row", justifyContent: "flex-start" },
  content: { flex: 1, minWidth: 0, gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
