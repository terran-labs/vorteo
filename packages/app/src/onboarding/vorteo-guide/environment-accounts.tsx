import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { primaryConnectionBinding } from "@getpaseo/protocol/installation-settings";
import { useCallback, useEffect, useState } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { isWeb } from "@/constants/platform";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { AddClaudeAccountButton, AddCodexAccountButton } from "@/provider-usage/add-account";
import { useInstallationConnectOnce } from "@/provider-usage/use-provider-login";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { usePrimaryConnection } from "@/execution-installation/primary-connection";
import { useInstallationSettings } from "@/execution-installation/settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { guideProviderSignedIn, refreshGuideProviderSnapshot } from "./model";

interface EnvironmentAccountsProps {
  serverId: string;
  initialProviderId?: string | null;
  onUse(providerId: string): Promise<unknown> | void;
  onSkip(): void;
  onSettings(): void;
}

export function EnvironmentAccounts({
  serverId,
  onUse,
  initialProviderId = null,
  onSkip,
  onSettings,
}: EnvironmentAccountsProps) {
  const { t } = useTranslation();
  const { supported: primarySupported, primary } = usePrimaryConnection();
  const savedPrimary = useSavedPrimaryRuntimeId(primarySupported, primary, serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const snapshot = useProvidersSnapshot(serverId, { enabled: connected });
  const { view: usage } = useProviderUsage(serverId);
  const connectOnce = useInstallationConnectOnce(connected);
  useDirectoryDemand(serverId);
  const snapshotAvailable = connected && snapshot.supportsSnapshot;
  const {
    mutate: retry,
    error: refreshError,
    isPending,
  } = useMutation({
    mutationFn: () => refreshGuideProviderSnapshot(snapshot),
  });
  const refresh = useCallback(() => retry(), [retry]);
  const [selected, setSelected] = useState<string | null>(initialProviderId);
  // Error strings do not carry SIGN_IN_REQUIRED on the wire. Do not infer installation
  // from a failed catalog refresh or turn that failure into an account-creation action.
  const installed = (snapshot.entries ?? []).filter(
    (entry) => entry.enabled && entry.status === "ready",
  );
  const readings = usage.kind === "ready" && !usage.refreshError ? usage.payload.providers : [];
  const preferred =
    installed.find((entry) => entry.provider === savedPrimary) ??
    installed.find((entry) => guideProviderSignedIn(entry, readings)) ??
    installed[0];
  const choice = installed.find((entry) => entry.provider === selected) ?? preferred;
  const noProvider = snapshotAvailable && !snapshot.isLoading && installed.length === 0;
  const refreshing = snapshot.isRefreshing || isPending;
  useEffect(() => {
    if (!noProvider || refreshing) return;
    // Installation happens outside this sheet. Re-detect without reload, while visible,
    // without creating overlapping refreshes or querying an unsupported host.
    const timer = setInterval(() => {
      if (isWeb && document.visibilityState === "hidden") return;
      refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [noProvider, refreshing, refresh]);
  let error = snapshot.error;
  if (refreshError) error = toErrorMessage(refreshError);
  const choicesAvailable = snapshotAvailable && !error;
  const signedIn = Boolean(choice && guideProviderSignedIn(choice, readings));
  const connection = useMutation({
    mutationFn: async () => {
      if (!choicesAvailable || !choice || !signedIn) return;
      await onUse(choice.provider);
    },
  });
  const useChoice = useCallback(() => connection.mutate(), [connection]);
  return (
    <SettingsSection title={t("vorteoSetup.providers")}>
      <ProviderDetection
        connected={connected}
        supported={snapshot.supportsSnapshot}
        loading={snapshot.isLoading}
        noProvider={noProvider}
      />
      <InstalledChoice
        available={choicesAvailable}
        serverId={serverId}
        installed={installed}
        choice={choice}
        signedIn={signedIn}
        connectOnce={connectOnce}
        onSelect={setSelected}
        onUse={useChoice}
        pending={connection.isPending}
      />
      {!primarySupported ? (
        <Text style={settingsStyles.rowHint}>{t("vorteoSetup.primaryLocalOnly")}</Text>
      ) : null}
      {connection.error ? (
        <>
          <Alert variant="warning" description={toErrorMessage(connection.error)} />
          <Button variant="outline" onPress={useChoice} loading={connection.isPending}>
            {t("vorteoSetup.retryPrimary")}
          </Button>
        </>
      ) : null}
      {error ? <Alert variant="warning" description={error} /> : null}
      {snapshotAvailable ? (
        <Button variant="outline" onPress={refresh} loading={refreshing}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
      <Button variant="ghost" onPress={onSettings}>
        {t("vorteoSetup.manageAccounts")}
      </Button>
      <Button variant="ghost" onPress={onSkip}>
        {t("vorteoSetup.skipProvider")}
      </Button>
    </SettingsSection>
  );
}

/** The saved primary connection, as this Host's runtime provider id. */
function useSavedPrimaryRuntimeId(
  supported: boolean,
  primary: ReturnType<typeof usePrimaryConnection>["primary"],
  serverId: string,
): string | undefined {
  const settings = useInstallationSettings(supported);
  if (!primary) return undefined;
  const definition = primaryConnectionBinding(
    {
      primaryConnection: primary,
      providerDefinitions: settings.data?.settings?.providerDefinitions ?? [],
    },
    serverId,
  );
  return definition?.bindings[serverId];
}

interface ProviderDetectionProps {
  connected: boolean;
  supported: boolean;
  loading: boolean;
  noProvider: boolean;
}
function ProviderDetection({ connected, supported, loading, noProvider }: ProviderDetectionProps) {
  const { t } = useTranslation();
  let message: string | null = null;
  if (!connected) message = t("vorteoSetup.offline");
  else if (!supported) message = t("vorteoSetup.unknown");
  else if (loading) message = t("common.loading");
  else if (noProvider) message = t("vorteoSetup.noAccounts");
  return message ? <Text style={settingsStyles.rowHint}>{message}</Text> : null;
}

interface InstalledChoiceProps {
  available: boolean;
  pending: boolean;
  serverId: string;
  installed: ProviderSnapshotEntry[];
  choice: ProviderSnapshotEntry | undefined;
  signedIn: boolean;
  connectOnce: ReturnType<typeof useInstallationConnectOnce>;
  onSelect(providerId: string): void;
  onUse(): void;
}
function InstalledChoice({
  available,
  pending,
  serverId,
  installed,
  choice,
  signedIn,
  connectOnce,
  onSelect,
  onUse,
}: InstalledChoiceProps) {
  const { t } = useTranslation();
  if (!available || !choice) return null;
  const label = choice.label ?? choice.provider;
  let action = <Text style={settingsStyles.rowHint}>{t("vorteoSetup.signInUnknown")}</Text>;
  if (signedIn)
    action = (
      <Button onPress={onUse} loading={pending}>
        {t("vorteoSetup.useProvider", { provider: label })}
      </Button>
    );
  else if (choice.provider === "claude" && connectOnce.claude === true)
    action = (
      <AddClaudeAccountButton
        serverId={serverId}
        catalog
        label={t("vorteoSetup.connectProvider", { provider: label })}
      />
    );
  else if (choice.provider === "codex" && connectOnce.codex === true)
    action = (
      <AddCodexAccountButton
        serverId={serverId}
        catalog
        label={t("vorteoSetup.connectProvider", { provider: label })}
      />
    );
  return (
    <>
      {installed.length > 1 ? (
        <DropdownMenu>
          <DropdownTrigger
            accessibilityLabel={t("vorteoSetup.chooseProviderCurrent", { provider: label })}
          >
            {label}
          </DropdownTrigger>
          <DropdownMenuContent>
            {installed.map((entry) => (
              <ProviderOption key={entry.provider} entry={entry} onSelect={onSelect} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {action}
    </>
  );
}
function ProviderOption({
  entry,
  onSelect,
}: {
  entry: ProviderSnapshotEntry;
  onSelect(providerId: string): void;
}) {
  const choose = useCallback(() => onSelect(entry.provider), [onSelect, entry.provider]);
  return <DropdownMenuItem onSelect={choose}>{entry.label ?? entry.provider}</DropdownMenuItem>;
}
