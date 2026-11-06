import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";

import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";

import { useReportActionError } from "@/hooks/use-action-error";

const METADATA_GENERATION_DOCS_URL = "https://paseo.sh/docs/metadata-generation";
type SelectionMode = "automatic" | "preferred";

export function MetadataGenerationPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const configuredProviders = config?.metadataGeneration.providers;
  const configuredProvider = configuredProviders?.[0] ?? null;
  const savedMode: SelectionMode = configuredProvider ? "preferred" : "automatic";
  const [draftMode, setDraftMode] = useState<SelectionMode | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const pulse = useSkeletonPulse();
  const mode = draftMode ?? savedMode;

  useEffect(() => {
    setDraftMode(null);
  }, [configuredProvider?.model, configuredProvider?.provider]);

  const modeOptions = useMemo(
    () => [
      {
        value: "automatic" as const,
        label: t("settings.metadataGeneration.automatic"),
        disabled: isSaving,
      },
      {
        value: "preferred" as const,
        label: t("settings.metadataGeneration.preferred"),
        disabled: isSaving,
      },
    ],
    [t, isSaving],
  );

  const reportActionError = useReportActionError();
  const saveProviders = useCallback(
    async (providersPatch: { provider: string; model?: string }[]) => {
      setIsSaving(true);
      try {
        await patchConfig({ metadataGeneration: { providers: providersPatch } });
      } catch (error) {
        setDraftMode(null);
        reportActionError(error);
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig, reportActionError],
  );

  const handleModeChange = useCallback(
    (next: SelectionMode) => {
      setDraftMode(next);
      if (next === "automatic") {
        void saveProviders([]);
      }
    },
    [saveProviders],
  );

  const handleModelSelect = useCallback(
    (provider: AgentProvider, model: string) => {
      setDraftMode("preferred");
      void saveProviders([
        { provider, ...(model ? { model } : {}) },
        ...(configuredProviders?.slice(1) ?? []),
      ]);
    },
    [configuredProviders, saveProviders],
  );

  const handleSelectorOpen = useCallback(() => {
    snapshot.refetchIfStale(configuredProvider?.provider);
  }, [configuredProvider?.provider, snapshot]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => snapshot.refresh([provider]),
    [snapshot],
  );
  const docsLink = useMemo(
    () => ({ href: METADATA_GENERATION_DOCS_URL, label: t("settings.metadataGeneration.docs") }),
    [t],
  );

  return (
    <SettingsSection
      title={t("settings.metadataGeneration.title")}
      info={t("settings.metadataGeneration.description")}
      link={docsLink}
      status={isSaving ? "Saving..." : null}
      testID="metadata-generation-settings"
    >
      <View style={[settingsStyles.card, styles.card]}>
        {!config ? (
          <View style={styles.loading} testID="metadata-generation-loading">
            <SkeletonPulse pulse={pulse} style={styles.skeleton} />
          </View>
        ) : (
          <>
            <View style={settingsStyles.row}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.metadataGeneration.selection")}
                </Text>
                <Text style={settingsStyles.rowHint}>
                  {mode === "automatic"
                    ? t("settings.metadataGeneration.automaticHint")
                    : t("settings.metadataGeneration.preferredHint")}
                </Text>
              </View>
              <SegmentedControl
                options={modeOptions}
                value={mode}
                onValueChange={handleModeChange}
                testID="metadata-generation-mode"
              />
            </View>
            {mode === "preferred" ? (
              <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
                <View style={settingsStyles.rowContent}>
                  <Text style={settingsStyles.rowTitle}>
                    {t("settings.metadataGeneration.model")}
                  </Text>
                  <Text style={settingsStyles.rowHint}>
                    {t("settings.metadataGeneration.modelHint")}
                  </Text>
                </View>
                <CombinedModelSelector
                  providers={providers}
                  selectedProvider={configuredProvider?.provider ?? ""}
                  selectedModel={configuredProvider?.model ?? ""}
                  onSelect={handleModelSelect}
                  isLoading={snapshot.isLoading && !snapshot.entries}
                  onOpen={handleSelectorOpen}
                  onRetryProvider={handleRetryProvider}
                  isRetryingProvider={snapshot.isRefreshing}
                  disabled={isSaving}
                  serverId={serverId}
                  desktopPlacement="bottom-start"
                  desktopMinWidth={360}
                />
              </View>
            ) : null}
          </>
        )}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { minHeight: 184 },
  loading: { minHeight: 184, padding: theme.spacing[3], justifyContent: "center" },
  skeleton: { height: 24, width: "60%", borderRadius: theme.borderRadius.md },
}));
