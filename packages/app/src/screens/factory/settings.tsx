import { useIsFocused } from "expo-router/react-navigation";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { useProjectFactory } from "@/components/sidebar/factory-instructions";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { PLUGIN_SURFACE_MESSAGES } from "@/plugins/surface-contribution";
import { useFactoryPlugin } from "./availability";
import { FactoryModelsAndRoles } from "./overview-controls";
import { useProjectNames } from "./overview-sources";

/**
 * One live Factory's settings: where its home is, the models for each issue stage and where
 * issue agents run, each role, and the role assignments. Each control saves on its own and the
 * daemon's owner-only lock applies to every write.
 */
export function FactorySettings({ serverId, projectId }: { serverId: string; projectId: string }) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  useDirectoryDemand(focused ? serverId : null);
  const { availability } = useFactoryPlugin(serverId);
  const factory = useProjectFactory(serverId, projectId, focused);
  const name = useProjectNames()(serverId, projectId);
  const reload = useCallback(() => {
    void factory.refetch();
  }, [factory]);
  const state = factory.data;
  return (
    <PageLayout
      title={
        name
          ? t("projectFactory.settings.title", { project: name })
          : t("projectFactory.settings.titleFallback")
      }
      testID="factory-settings"
    >
      {factory.error ? (
        <View>
          <Text style={styles.text} accessibilityRole="alert">
            {factory.error.message}
          </Text>
          <Button onPress={reload} disabled={factory.isFetching}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {availability === "offline" && !state ? (
        <Text style={styles.text}>{PLUGIN_SURFACE_MESSAGES.offline}</Text>
      ) : null}
      {availability === "unavailable" ? (
        <Text style={styles.text}>{t("projectFactory.states.unavailable")}</Text>
      ) : null}
      {!state && !factory.error && availability !== "offline" && availability !== "unavailable" ? (
        <Text style={styles.text}>{t("projectFactory.loading")}</Text>
      ) : null}
      {state?.state === "off" ? (
        <Text style={styles.text}>{t("projectFactory.states.off")}</Text>
      ) : null}
      {state && state.state !== "off" ? (
        <FactoryModelsAndRoles serverId={serverId} projectId={projectId} state={state} />
      ) : null}
    </PageLayout>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
