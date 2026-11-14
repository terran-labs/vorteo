import { useRetainedUsage } from "@/components/settings/use-retained-usage";
import { useToast } from "@/contexts/toast-context";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
/**
 * One provider's details, expanded in place under its row in Accounts &
 * profiles.
 *
 * A connection belongs to the installation, not to an environment: rows show
 * one combined status ("Ready everywhere") and environments only appear when
 * something differs or the owner opens Environment access. Profiles and model
 * defaults for the provider sit below its connections, and removing the
 * provider is a quiet row at the bottom. The row above keeps the provider's
 * name and its on and off switch.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { SettingsExpansionHeader } from "@/components/settings/settings-expansion";
import { SettingsAdvancedGroup } from "@/components/settings/advanced-group";
import { formatPct } from "@/provider-usage/format";
import type { ProviderUsageWindow } from "@/provider-usage/types";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, MoreHorizontal } from "lucide-react-native";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type {
  InstallationSettings,
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { SharedProviderSection } from "@/agent-profiles/settings/shared-provider-section";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  canMakePrimary as offersMakePrimary,
  confirmDisablePrimary,
  confirmPrimaryConnection,
  isPrimaryConnection,
  usePrimaryConnection,
} from "@/execution-installation/primary-connection";
import { selectProfileCatalogSources } from "@/execution-installation/profile-catalog";
import {
  requestInstallationSettings,
  useInstallationSettings,
} from "@/execution-installation/settings";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import {
  describeSecretDelivery,
  useProviderSecrets,
} from "@/execution-installation/provider-secrets";
import type { ProviderSecretsStatus } from "@getpaseo/protocol/provider-secrets";
import { SettingsInput } from "@/components/settings";
import { settingsStyles } from "@/styles/settings";
import { hoverStyle } from "@/styles/hover";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isConnectionError, toErrorMessage } from "@/utils/error-messages";
import { useReportActionError } from "@/hooks/use-action-error";
import { ProvidersSection } from "./providers-section";
import {
  classifyEnvironment,
  describeConnectionStatus,
  environmentLabel,
  needsAttention,
  type EnvironmentState,
} from "./provider-connection-status";
import {
  groupInstallationProviders,
  type ProviderAccount,
  type ProviderFamily,
} from "./shared-providers-model";
import { useProviderDetection } from "./use-provider-detection";

const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedChevron = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColor = (theme: Theme) => ({ color: theme.colors.foreground });
// On web the icon inherits the menu button's CSS color, so browser-owned :hover brightens it.
const inheritedIconColor = isWeb ? () => ({ color: "currentColor" }) : mutedColor;

/** Lost connections are reported as toasts, so only host rejections stay on the page. */
export function hostRejection(error: Error | null): Error | null {
  if (!error || isConnectionError(error)) return null;
  return error;
}

/** Report mutation failures without inserting feedback into the page. */
export function useConnectionLostReporter() {
  const reportActionError = useReportActionError();
  const toast = useToast();
  return useCallback(
    (failure: Error) => {
      if (isConnectionError(failure)) reportActionError(failure);
      else toast.error(toErrorMessage(failure));
    },
    [reportActionError, toast],
  );
}

export function providerTypeLabel(type: string): string {
  return AGENT_PROVIDER_DEFINITIONS.find((manifest) => manifest.id === type)?.label ?? type;
}

export function providerName(provider: InstallationProvider) {
  return provider.policy.label ?? providerTypeLabel(provider.providerType);
}

/** Removal needs every environment to understand shared removal before it is offered. */
export function useProviderRemovalCapability(environments: InstallationEnvironment[]) {
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId ?? null;
  const devId =
    environments.find((environment) => environment.kind === "container")?.serverId ?? null;
  const hostRemoval = useHostFeature(hostId, "installationProviderRemoval");
  const devRemoval = useHostFeature(devId, "installationProviderRemoval");
  return hostRemoval && (!devId || devRemoval);
}

function isExcluded(settings: InstallationSettings, serverId: string, providerId: string) {
  return settings.resourceExclusions[serverId]?.providerIds?.includes(providerId) ?? false;
}

// ---------------------------------------------------------------------------
// Environment state for one connection
// ---------------------------------------------------------------------------

/**
 * One environment's view of a connection. Called once for Host and once for
 * the Dev container so hook order stays fixed; a missing environment reports
 * `none` and is left out of the combined status.
 */
function useEnvironmentState(
  provider: InstallationProvider,
  environment: InstallationEnvironment | undefined,
  settings: InstallationSettings,
): EnvironmentState | null {
  const serverId = environment?.serverId ?? null;
  const localId = serverId ? provider.bindings[serverId] : undefined;
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const catalog = useProvidersSnapshot(localId ? serverId : null);
  const usageSupported = useHostFeature(serverId, "providerUsageList");
  const { view } = useProviderUsage(serverId, {
    enabled: Boolean(localId && connected),
  });
  if (!environment) return null;
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((item) => item.providerId === localId)
      : undefined;
  const entry = catalog.entries?.find((item) => item.provider === localId);
  return {
    environment,
    usage,
    usageSupported: Boolean(localId && usageSupported),
    usageFailed: view.kind === "error" || (view.kind === "ready" && Boolean(view.refreshError)),
    ...classifyEnvironment({
      bound: Boolean(localId),
      excluded: isExcluded(settings, environment.serverId, provider.id),
      connected,
      needsSignIn: Boolean(usage?.authRecovery),
      entry,
      settled: !catalog.isLoading,
    }),
  };
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/** Rendered inside the provider list, which already waits for installation settings. */
export function ProviderDetail({ providerType }: { providerType: string }) {
  const { data, installation, save } = useInstallationSettings();
  const environments = useMemo(() => installation?.environments ?? [], [installation]);
  const reportConnectionLost = useConnectionLostReporter();
  const change = useMutation({
    mutationFn: save,
    onError: reportConnectionLost,
  });
  const definitions = useMemo(
    () =>
      (change.isPending ? change.variables?.settings.providerDefinitions : undefined) ??
      data?.settings?.providerDefinitions ??
      null,
    [data, change.isPending, change.variables],
  );
  const detection = useProviderDetection(environments);
  const family = useMemo(
    () =>
      groupInstallationProviders(definitions ?? [], "active", detection).find(
        (entry) => entry.id === providerType,
      ),
    [definitions, providerType, detection],
  );
  const canRemove = useProviderRemovalCapability(environments);
  if (!data?.settings || !definitions)
    return (
      <View style={reservedLayout1}>
        <SettingsStatusLine message="Loading provider settings..." />
      </View>
    );
  if (!family) {
    const removed = groupInstallationProviders(definitions, "removed").some(
      (entry) => entry.id === providerType,
    );
    return (
      <Alert
        description={
          removed
            ? `${providerTypeLabel(
                providerType,
              )} was removed. Restore it from Add provider in Accounts & profiles.`
            : `${providerTypeLabel(
                providerType,
              )} is not in this installation. Add it from Accounts & profiles.`
        }
      />
    );
  }
  const snapshot = data as InstallationSettingsSnapshot & {
    settings: InstallationSettings;
  };
  // Each group below is a run of divided rows inside the provider's own card: no inner cards.
  return (
    <View>
      <ConnectionsSection
        family={family}
        snapshot={snapshot}
        environments={environments}
        busy={change.isPending}
        save={change.mutate}
        saveAsync={change.mutateAsync}
        saving={change.isPending}
      />
      <ProviderProfiles providerType={providerType} environments={environments} />
      {canRemove ? (
        <RemoveProviderRow
          family={family}
          snapshot={snapshot}
          busy={change.isPending}
          saveAsync={change.mutateAsync}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

type SettingsSave = ReturnType<typeof useInstallationSettings>["save"];

function ConnectionsSection({
  family,
  snapshot,
  environments,
  busy,
  save,
  saveAsync,
  saving,
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  environments: InstallationEnvironment[];
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  saveAsync: SettingsSave;
  saving: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<ProviderAccount | null>(null);
  const [details, setDetails] = useState<ProviderAccount | null>(null);
  const [keys, setKeys] = useState<ProviderAccount | null>(null);
  const secrets = useProviderSecrets();
  const primary = usePrimaryConnection();
  const toast = useToast();
  const { choose } = primary;
  const makePrimary = useCallback(
    (account: ProviderAccount, name: string) =>
      void confirmPrimaryConnection({
        name,
        providerId: primaryDefinition(account, environments).id,
        confirm: confirmDialog,
        choose,
        toast,
        describeError: toErrorMessage,
      }),
    [choose, environments, toast],
  );
  const closeKeys = useCallback(() => setKeys(null), []);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const closeRename = useCallback(() => setRenaming(null), []);
  const closeDetails = useCallback(() => setDetails(null), []);
  const rename = useCallback(
    async (name: string) => {
      if (!renaming) return;
      const ids = new Set(renaming.definitions.map((entry) => entry.id));
      await saveAsync({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings.providerDefinitions?.map((provider) =>
            ids.has(provider.id)
              ? {
                  ...provider,
                  policy: { ...provider.policy, label: name.trim() },
                }
              : provider,
          ),
        },
      });
    },
    [renaming, saveAsync, snapshot],
  );
  const addButton = useMemo(
    () => (
      <Button variant="outline" onPress={openAdd} testID="provider-detail-add-connection">
        Add connection
      </Button>
    ),
    [openAdd],
  );
  const [showingAll, setShowingAll] = useState(false);
  // A dialog opened from the full list replaces it, so two sheets never stack (iOS shows only one).
  const renameFromList = useCallback((account: ProviderAccount) => {
    setShowingAll(false);
    setRenaming(account);
  }, []);
  const detailsFromList = useCallback((account: ProviderAccount) => {
    setShowingAll(false);
    setDetails(account);
  }, []);
  const keysFromList = useCallback((account: ProviderAccount) => {
    setShowingAll(false);
    setKeys(account);
  }, []);
  const showAll = useCallback(() => setShowingAll(true), []);
  const closeAll = useCallback(() => setShowingAll(false), []);
  const allHeader = useMemo(() => ({ title: `${family.name} connections` }), [family.name]);
  // Details always reads the latest definitions, not the copy captured when opened.
  const currentDetails = details
    ? family.accounts.find((account) => account.id === details.id)
    : undefined;
  // A handful of connections stay inline. A long list keeps the card short and opens in full.
  const overflow = family.accounts.length > CONNECTION_PREVIEW_LIMIT;
  const inline = overflow
    ? family.accounts.slice(0, CONNECTION_PREVIEW_LIMIT - 1)
    : family.accounts;
  const renderRow = (account: ProviderAccount, first: boolean) => (
    <ConnectionRow
      key={account.id}
      account={account}
      snapshot={snapshot}
      environments={environments}
      first={first}
      busy={busy}
      save={save}
      onRename={renameFromList}
      onDetails={detailsFromList}
      onKeys={keysFromList}
      secrets={secrets.byDefinition.get(primaryDefinition(account, environments).id)}
      primary={primary.loaded ? isPrimaryConnection(primary.primary, account.definitions) : null}
      onMakePrimary={makePrimary}
    />
  );
  return (
    <View testID="provider-detail-connections">
      <SettingsExpansionHeader
        title="Connections"
        trailing={addButton}
        status={saving ? "Saving..." : null}
        info="A connection works in every environment. Use Environment access only to keep it out of a specific environment."
        testID="provider-detail-connections-header"
      />
      {inline.map((account) => renderRow(account, false))}
      {overflow ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <Text style={[settingsStyles.rowHint, styles.overflowHint]}>
            {`${family.accounts.length - inline.length} more`}
          </Text>
          <Button
            {...OPENS_DIALOG}
            variant="outline"
            onPress={showAll}
            accessibilityLabel={`Show all ${family.accounts.length} ${family.name} connections`}
            testID="provider-detail-all-connections"
          >{`Show all ${family.accounts.length}`}</Button>
        </View>
      ) : null}
      {showingAll ? (
        <AdaptiveModalSheet
          testID="provider-all-connections-sheet"
          visible
          onClose={closeAll}
          header={allHeader}
        >
          <View style={settingsStyles.card}>
            {family.accounts.map((account, index) => renderRow(account, index === 0))}
          </View>
        </AdaptiveModalSheet>
      ) : null}
      <AddConnectionSheet visible={adding} environments={environments} onClose={closeAdd} />
      {currentDetails ? (
        <EnvironmentAccessSheet
          account={currentDetails}
          snapshot={snapshot}
          environments={environments}
          busy={busy}
          save={save}
          onClose={closeDetails}
        />
      ) : null}
      {keys ? (
        <ApiKeysSheet
          name={keys.name}
          definitionId={primaryDefinition(keys, environments).id}
          status={secrets.byDefinition.get(primaryDefinition(keys, environments).id)}
          environments={environments}
          setSecret={secrets.setSecret}
          clearSecret={secrets.clearSecret}
          onClose={closeKeys}
        />
      ) : null}
      {renaming ? (
        <AdaptiveRenameModal
          key={renaming.id}
          visible
          title="Rename connection"
          initialValue={renaming.name}
          onClose={closeRename}
          onSubmit={rename}
          testID="shared-provider-rename-dialog"
        />
      ) : null}
    </View>
  );
}

/** Tells screen readers on web that the button opens a dialog. */
const OPENS_DIALOG = isWeb ? ({ "aria-haspopup": "dialog" } as object) : {};

/** Up to this many connections show inline; more open the full list in a sheet. */
const CONNECTION_PREVIEW_LIMIT = 5;

function primaryDefinition(account: ProviderAccount, environments: InstallationEnvironment[]) {
  const host = environments.find((environment) => environment.kind === "host");
  return (
    (host && account.definitions.find((entry) => entry.bindings[host.serverId])) ??
    account.definitions[0]!
  );
}

function isUsageValid(state: EnvironmentState | undefined): boolean {
  return Boolean(state && state.kind !== "attention" && !state.usageFailed);
}

/** "5-hour 42% · Weekly 10%": every usage window on one short line. */
function usageSummary(windows: readonly ProviderUsageWindow[]): string | null {
  const parts = windows.flatMap((window) => {
    const used = window.usedPct ?? (window.remainingPct != null ? 100 - window.remainingPct : null);
    return used == null ? [] : [`${window.label} ${formatPct(used)}`];
  });
  return parts.length ? parts.join(" · ") : null;
}

/** Everything one connection row reads about its environments, usage and sign-in. */
function useConnectionState(
  account: ProviderAccount,
  environments: InstallationEnvironment[],
  settings: InstallationSettings,
) {
  const provider = primaryDefinition(account, environments);
  const host = environments.find((environment) => environment.kind === "host");
  const dev = environments.find((environment) => environment.kind === "container");
  const hostState = useEnvironmentState(provider, host, settings);
  const devState = useEnvironmentState(provider, dev, settings);
  const states = [hostState, devState].filter((state): state is EnvironmentState => !!state);
  const usageState = states.find((state) => state.kind !== "none" && state.kind !== "excluded");
  const usageServerId = usageState?.environment.serverId;
  const { usage } = useRetainedUsage({
    identity: JSON.stringify([
      account.id,
      provider.id,
      usageServerId,
      provider.bindings[usageServerId ?? ""],
    ]),
    supported: Boolean(usageState?.usageSupported),
    valid: isUsageValid(usageState),
    latest: usageState?.usage,
  });
  // Sign-ins run on Host; the Dev container receives access from there.
  const signInEnvironment =
    host && provider.bindings[host.serverId] ? host : states[0]?.environment;
  return {
    states,
    status: describeConnectionStatus(states),
    attention: needsAttention(states),
    error: states.find((state) => state.error)?.error ?? null,
    windows: usage?.windows ?? [],
    name: account.name === "Default connection" ? providerName(provider) : account.name,
    signInEnvironment,
    signInId: signInEnvironment ? provider.bindings[signInEnvironment.serverId] : undefined,
    signInUsage: states.find((state) => state.environment === signInEnvironment)?.usage,
  };
}

/**
 * One connection on one line: name, status, usage and its actions. Sign-in hints, errors and
 * the usage bars are secondary, so they open under the row from its name.
 */
function ConnectionRow({
  account,
  snapshot,
  environments,
  first,
  busy,
  save,
  onRename,
  onDetails,
  onKeys,
  secrets,
  primary,
  onMakePrimary,
}: {
  account: ProviderAccount;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  environments: InstallationEnvironment[];
  first: boolean;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  onRename(account: ProviderAccount): void;
  onDetails(account: ProviderAccount): void;
  onKeys(account: ProviderAccount): void;
  secrets: ProviderSecretsStatus | undefined;
  /** Whether this is the primary connection; null where the setting is unavailable. */
  primary: boolean | null;
  onMakePrimary(account: ProviderAccount, name: string): void;
}) {
  const isCompact = useIsCompactFormFactor();
  const [open, setOpen] = useState(false);
  const toggleOpen = useCallback(() => setOpen((value) => !value), []);
  const connection = useConnectionState(account, environments, snapshot.settings);
  const { states, name, signInEnvironment, signInId } = connection;
  const openModels = useProviderSettingsStore((state) => state.open);
  const showModels = useCallback(() => {
    if (signInEnvironment && signInId)
      openModels({ serverId: signInEnvironment.serverId, provider: signInId });
  }, [openModels, signInEnvironment, signInId]);
  const rename = useCallback(() => onRename(account), [onRename, account]);
  const details = useCallback(() => onDetails(account), [onDetails, account]);
  const keys = useCallback(() => onKeys(account), [onKeys, account]);
  const canMakePrimary = offersMakePrimary({ primary, enabled: account.enabled, states });
  const makePrimary = useCallback(
    () => onMakePrimary(account, name),
    [onMakePrimary, account, name],
  );
  const toggle = useCallback(
    async (enabled: boolean) => {
      if (!enabled && primary === true && !(await confirmDisablePrimary(name, confirmDialog)))
        return;
      const ids = new Set(account.definitions.map((entry) => entry.id));
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings.providerDefinitions?.map((entry) =>
            ids.has(entry.id) ? { ...entry, policy: { ...entry.policy, enabled } } : entry,
          ),
        },
      });
    },
    [account, snapshot, save, primary, name],
  );
  const summary = usageSummary(connection.windows);
  // Errors, undelivered keys and pending sign-ins ask something of the owner, so they always show.
  const notices = {
    error: connection.error,
    delivery: describeSecretDelivery(secrets),
    signIns: pendingSignIns(secrets, states),
  };
  // Only passive detail waits behind the disclosure.
  const detail = {
    cliLogin: account.id === "default/claude",
    // The usage bars, which also carry the summary the compact layout leaves off the line.
    windows: connection.windows,
  };
  const hasDetails = connectionHasDetails(detail);
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder, styles.connection]}
      testID={`provider-account-${account.id}`}
    >
      <View style={styles.connectionHeading}>
        <ConnectionDisclosure
          accountId={account.id}
          name={name}
          status={connection.status}
          attention={connection.attention}
          summary={summary}
          primary={primary === true}
          stacked={isCompact}
          open={open}
          onToggle={hasDetails ? toggleOpen : undefined}
        />
        {summary && !isCompact ? (
          <Text
            style={styles.usageSummary}
            numberOfLines={1}
            testID={`provider-connection-usage-summary-${account.id}`}
          >
            {summary}
          </Text>
        ) : null}
        <View style={styles.controls}>
          {signInEnvironment && signInId ? (
            <ProviderReconnectControl
              serverId={signInEnvironment.serverId}
              providerId={signInId}
              name={name}
              usage={connection.signInUsage}
            />
          ) : null}
          <Switch
            value={account.enabled}
            onValueChange={toggle}
            disabled={busy}
            accessibilityLabel={`Enable ${name}`}
          />
          <ConnectionMenu
            name={name}
            accountId={account.id}
            onModels={signInId ? showModels : undefined}
            onRename={rename}
            onDetails={details}
            onKeys={keys}
            onMakePrimary={canMakePrimary ? makePrimary : undefined}
          />
        </View>
      </View>
      <ConnectionNotices accountId={account.id} {...notices} />
      {open && hasDetails ? <ConnectionDetails accountId={account.id} {...detail} /> : null}
    </View>
  );
}

interface ConnectionDetailContent {
  cliLogin: boolean;
  windows: readonly ProviderUsageWindow[];
}

/** Only offer the disclosure when there is something under it. */
function connectionHasDetails(detail: ConnectionDetailContent): boolean {
  return Boolean(detail.cliLogin || detail.windows.length);
}

/** The name and status, which open the row's details when it has any. */
function ConnectionDisclosure({
  accountId,
  name,
  status,
  attention,
  summary,
  primary,
  stacked,
  open,
  onToggle,
}: {
  accountId: string;
  name: string;
  status: string;
  attention: boolean;
  summary: string | null;
  primary: boolean;
  stacked: boolean;
  open: boolean;
  onToggle?: () => void;
}) {
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`.
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": open } as const) : null),
    [open],
  );
  // The name starts on the same inset as the group labels above it; the disclosure chevron
  // follows the status rather than indenting the row.
  const identity = (
    <>
      <View style={[styles.identity, stacked && styles.identityStacked]}>
        <View style={styles.connectionTitle}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {name}
          </Text>
          {primary ? (
            <View testID={`provider-connection-primary-${accountId}`}>
              <StatusBadge label="Primary" size="xs" variant="success" />
            </View>
          ) : null}
        </View>
        <Text
          style={attention ? styles.statusAttention : styles.status}
          numberOfLines={1}
          testID={`provider-connection-status-${accountId}`}
        >
          {status}
        </Text>
      </View>
      {onToggle ? (
        <View style={open ? styles.chevronExpanded : undefined}>
          <ThemedChevron size={14} uniProps={inheritedIconColor} />
        </View>
      ) : null}
    </>
  );
  if (!onToggle) return <View style={styles.disclosure}>{identity}</View>;
  return (
    <Pressable
      {...webExpandedProps}
      onPress={onToggle}
      style={styles.disclosure}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${status}${summary ? `, ${summary}` : ""}`}
      accessibilityHint={open ? "Hide details" : "Show details"}
      accessibilityState={accessibilityState}
      testID={`provider-connection-toggle-${accountId}`}
    >
      {identity}
    </Pressable>
  );
}

/** What the owner must act on, always under the row's line rather than behind its disclosure. */
function ConnectionNotices({
  accountId,
  error,
  delivery,
  signIns,
}: {
  accountId: string;
  error: string | null;
  delivery: string | null;
  signIns: string[];
}) {
  if (!error && !delivery && !signIns.length) return null;
  return (
    <View style={styles.connectionDetails} testID={`provider-connection-notices-${accountId}`}>
      {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
      {delivery ? <Text style={settingsStyles.rowHint}>{delivery}</Text> : null}
      {signIns.length ? (
        <Text style={settingsStyles.rowHint}>
          {`${signIns.join(" · ")}. Sign in separately in each environment.`}
        </Text>
      ) : null}
    </View>
  );
}

function ConnectionDetails({
  accountId,
  cliLogin,
  windows,
}: ConnectionDetailContent & { accountId: string }) {
  return (
    <View style={styles.connectionDetails} testID={`provider-connection-details-${accountId}`}>
      {cliLogin ? (
        <Text style={settingsStyles.rowHint}>Uses the existing Claude CLI login.</Text>
      ) : null}
      {windows.length ? (
        <View style={styles.usage} testID={`provider-connection-usage-${accountId}`}>
          {windows.map((window) => (
            <ProviderUsageWindowBar key={window.id} window={window} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Environments a Codex-style sign-in still has to reach, read from the coordinator's hint. */
function pendingSignIns(
  secrets: ProviderSecretsStatus | undefined,
  states: readonly EnvironmentState[],
): string[] {
  return (secrets?.accountSignIn?.environments ?? [])
    .filter((environment) =>
      states.some(
        (state) =>
          state.environment.serverId === environment.serverId &&
          (state.kind === "attention" || state.kind === "none"),
      ),
    )
    .map((environment) => `Sign in on ${environment.label}`);
}

function ConnectionMenu({
  name,
  accountId,
  onModels,
  onRename,
  onDetails,
  onKeys,
  onMakePrimary,
}: {
  name: string;
  accountId: string;
  onModels?: () => void;
  onRename(): void;
  onDetails(): void;
  onKeys(): void;
  onMakePrimary?: () => void;
}) {
  const triggerStyle = useCallback(
    ({ open }: PressableStateCallbackType & { open?: boolean }) => [
      styles.menuButton,
      open && styles.menuButtonHovered,
    ],
    [],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={`${name} actions`}
        testID={`provider-connection-menu-${accountId}`}
      >
        {({ open }) => (
          <ThemedMore size={16} uniProps={open ? foregroundColor : inheritedIconColor} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {onModels ? (
          <DropdownMenuItem onSelect={onModels} testID={`provider-connection-models-${accountId}`}>
            Models
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onKeys} testID={`provider-connection-keys-menu-${accountId}`}>
          API keys
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename} testID={`provider-connection-rename-${accountId}`}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDetails} testID={`provider-connection-access-${accountId}`}>
          Environment access
        </DropdownMenuItem>
        {onMakePrimary ? (
          <DropdownMenuItem
            onSelect={onMakePrimary}
            testID={`provider-connection-make-primary-${accountId}`}
          >
            Make primary
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Account creation starts on Host and shares the connection with the installation. */
function AddConnectionSheet({
  visible,
  environments,
  onClose,
}: {
  visible: boolean;
  environments: InstallationEnvironment[];
  onClose(): void;
}) {
  const host = environments.find((environment) => environment.kind === "host");
  const dev = environments.find((environment) => environment.kind === "container");
  const target = host ?? dev;
  const header = useMemo(() => ({ title: "Add connection" }), []);
  return (
    <AdaptiveModalSheet
      testID="provider-add-connection-sheet"
      visible={visible}
      onClose={onClose}
      header={header}
    >
      <Text style={settingsStyles.rowHint}>
        Sign in once. Vorteo shares the connection with every environment.
      </Text>
      {target ? <ProvidersSection serverId={target.serverId} runtimeOnly /> : null}
    </AdaptiveModalSheet>
  );
}

// ---------------------------------------------------------------------------
// API keys, stored once by the coordinator and delivered everywhere
// ---------------------------------------------------------------------------

const SECRET_STATUS_LABEL = {
  delivered: "Has the current keys",
  pending: "Receiving keys",
  failed: "Not delivered",
  excluded: "Off here",
} as const;

function ApiKeysSheet({
  name,
  definitionId,
  status,
  environments,
  setSecret,
  clearSecret,
  onClose,
}: {
  name: string;
  definitionId: string;
  status: ProviderSecretsStatus | undefined;
  environments: InstallationEnvironment[];
  setSecret(definitionId: string, name: string, value: string): Promise<void>;
  clearSecret(definitionId: string, name: string): Promise<void>;
  onClose(): void;
}) {
  const header = useMemo(() => ({ title: `${name}: API keys` }), [name]);
  const [keyName, setKeyName] = useState(status?.secrets[0]?.name ?? "");
  const [value, setValue] = useState("");
  const [formKey, setFormKey] = useState(0);
  const reportConnectionLost = useConnectionLostReporter();
  const saving = useMutation({
    mutationFn: () => setSecret(definitionId, keyName.trim(), value),
    onError: reportConnectionLost,
    onSuccess: () => {
      setValue("");
      setFormKey((key) => key + 1);
    },
  });
  const clearing = useMutation({
    mutationFn: (secretName: string) => clearSecret(definitionId, secretName),
    onError: reportConnectionLost,
  });
  const save = useCallback(() => saving.mutate(), [saving]);
  const labelFor = useCallback(
    (serverId: string) => {
      const environment = environments.find((entry) => entry.serverId === serverId);
      return environment ? environmentLabel(environment) : serverId;
    },
    [environments],
  );
  return (
    <AdaptiveModalSheet testID="provider-keys-sheet" visible onClose={onClose} header={header}>
      <Text style={settingsStyles.rowHint}>
        Save a key once. Vorteo stores it on Host and delivers it to every environment within a few
        seconds. Saved values are never shown again.
      </Text>

      {status?.conflicts.map((conflict) => (
        <Alert
          key={conflict.name}
          description={`${conflict.name} has different values in ${conflict.serverIds
            .map(labelFor)
            .join(" and ")}. Set it here to use one value everywhere.`}
        />
      ))}
      {status?.secrets.length ? (
        <View style={settingsStyles.card}>
          {status.secrets.map((secret, index) => (
            <SecretRow
              key={secret.name}
              name={secret.name}
              detail={`${secret.last4 ? `Ends in ${secret.last4} · ` : ""}${
                secret.source === "imported" ? "Imported" : "Saved"
              } ${new Date(secret.updatedAt).toLocaleString()}`}
              first={index === 0}
              busy={clearing.isPending}
              onClear={clearing.mutate}
            />
          ))}
        </View>
      ) : null}
      <View style={settingsStyles.card} key={formKey}>
        <SettingsInput
          label="Key name"
          hint="Environment variable, ending in _KEY, _TOKEN, _SECRET or _PASSWORD"
          initialValue={keyName}
          onChangeText={setKeyName}
          placeholder="ZAI_API_KEY"
        />
        <SettingsInput
          label="Value"
          initialValue=""
          onChangeText={setValue}
          placeholder="Paste the key"
          secureTextEntry
        />
      </View>
      <Button
        onPress={save}
        variant="default"
        loading={saving.isPending}
        disabled={saving.isPending || !keyName.trim() || !value}
        testID="provider-keys-save"
      >
        {saving.isPending ? "Saving..." : "Save key"}
      </Button>
      {status?.environments.length ? (
        <KeyDelivery environments={status.environments} labelFor={labelFor} />
      ) : null}
    </AdaptiveModalSheet>
  );
}

/**
 * Where saved keys have reached. While any environment is still waiting or failed, the list shows
 * in the sheet, since it asks the owner to act; once every environment has the keys it folds
 * under Advanced.
 */
function KeyDelivery({
  environments,
  labelFor,
}: {
  environments: ProviderSecretsStatus["environments"];
  labelFor(serverId: string): string;
}) {
  const card = (
    <View style={settingsStyles.card}>
      {environments.map((environment, index) => (
        <View
          key={environment.serverId}
          style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}
        >
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{labelFor(environment.serverId)}</Text>
            <Text
              style={
                environment.status === "failed" ? settingsStyles.rowError : settingsStyles.rowHint
              }
            >
              {environment.message ?? SECRET_STATUS_LABEL[environment.status]}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
  const waiting = environments.some(
    (environment) => environment.status === "failed" || environment.status === "pending",
  );
  if (waiting) return card;
  return (
    <SettingsAdvancedGroup title="Delivery details" testID="provider-keys-delivery">
      {card}
    </SettingsAdvancedGroup>
  );
}

function SecretRow({
  name,
  detail,
  first,
  busy,
  onClear,
}: {
  name: string;
  detail: string;
  first: boolean;
  busy: boolean;
  onClear(name: string): void;
}) {
  const clear = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: `Remove ${name}?`,
      message: "Vorteo removes this key from every environment it delivered it to.",
      confirmLabel: "Remove key",
      destructive: true,
    });
    if (confirmed) onClear(name);
  }, [name, onClear]);
  const onPress = useCallback(() => {
    void clear();
  }, [clear]);
  return (
    <View style={[settingsStyles.row, !first && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{name}</Text>
        <Text style={settingsStyles.rowHint}>{detail}</Text>
      </View>
      <Button
        variant="outline"
        onPress={onPress}
        disabled={busy}
        accessibilityLabel={`Remove ${name}`}
      >
        Remove
      </Button>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Environment access (the rare per-environment view)
// ---------------------------------------------------------------------------

function EnvironmentAccessSheet({
  account,
  snapshot,
  environments,
  busy,
  save,
  onClose,
}: {
  account: ProviderAccount;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  environments: InstallationEnvironment[];
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  onClose(): void;
}) {
  const provider = primaryDefinition(account, environments);
  const header = useMemo(() => ({ title: `${account.name}: environment access` }), [account.name]);
  return (
    <AdaptiveModalSheet testID="provider-manage-sheet" visible onClose={onClose} header={header}>
      <Text style={settingsStyles.rowHint}>
        Connections are shared by every environment. Turn one off here only when an environment must
        not use it.
      </Text>
      <View style={settingsStyles.card}>
        {environments.map((environment, index) => (
          <EnvironmentAccessRow
            key={environment.serverId}
            provider={provider}
            environment={environment}
            snapshot={snapshot}
            first={index === 0}
            busy={busy}
            save={save}
          />
        ))}
      </View>
      {/* Removing a connection from one environment, or restoring it there, is rare repair work. */}
      <SettingsAdvancedGroup testID="provider-manage-advanced">
        <View style={settingsStyles.card}>
          {environments.map((environment, index) => (
            <EnvironmentRepairRow
              key={environment.serverId}
              provider={provider}
              environment={environment}
              first={index === 0}
            />
          ))}
        </View>
      </SettingsAdvancedGroup>
    </AdaptiveModalSheet>
  );
}

/** One environment's removal and restore actions, under Advanced in Environment access. */
function EnvironmentRepairRow({
  provider,
  environment,
  first,
}: {
  provider: InstallationProvider;
  environment: InstallationEnvironment;
  first: boolean;
}) {
  const localId = provider.bindings[environment.serverId];
  const catalog = useProvidersSnapshot(localId ? environment.serverId : null);
  const entry = catalog.entries?.find((item) => item.provider === localId);
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder, styles.connection]}
      testID={`shared-provider-repair-${provider.id}-${environment.serverId}`}
    >
      <Text style={settingsStyles.rowTitle}>{environmentLabel(environment)}</Text>
      {localId ? (
        <ProviderConnectionActions
          provider={provider}
          environment={environment}
          name={providerName(provider)}
          canRemove={entry?.source === "custom"}
          fallback="Nothing to remove or restore here"
        />
      ) : (
        <Text style={settingsStyles.rowHint}>Not set up here</Text>
      )}
    </View>
  );
}

function EnvironmentAccessRow({
  provider,
  environment,
  snapshot,
  first,
  busy,
  save,
}: {
  provider: InstallationProvider;
  environment: InstallationEnvironment;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  first: boolean;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
}) {
  const state = useEnvironmentState(provider, environment, snapshot.settings);
  const localId = provider.bindings[environment.serverId];
  const excluded = isExcluded(snapshot.settings, environment.serverId, provider.id);
  const location = environmentLabel(environment);
  const toggle = useCallback(
    (included: boolean) => {
      const settings = snapshot.settings;
      const previous = settings.resourceExclusions[environment.serverId];
      const ids = new Set(previous?.providerIds ?? []);
      if (included) ids.delete(provider.id);
      else ids.add(provider.id);
      save({
        expectedRevision: snapshot.revision,
        settings: {
          resourceExclusions: {
            ...settings.resourceExclusions,
            [environment.serverId]: {
              ...previous,
              terminalProfileIds: previous?.terminalProfileIds ?? [],
              metadataProviderIds: previous?.metadataProviderIds ?? [],
              providerIds: [...ids],
            },
          },
        },
      });
    },
    [snapshot, environment.serverId, provider.id, save],
  );
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder, styles.connection]}
      testID={`shared-provider-environment-${provider.id}-${environment.serverId}`}
    >
      <View style={styles.connectionHeading}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{location}</Text>
          <Text style={settingsStyles.rowHint}>{state?.label ?? "Checking"}</Text>
          <SettingsStatusLine message={!excluded ? state?.error : null} />
        </View>
        <View style={styles.controls}>
          <Switch
            value={!excluded}
            onValueChange={toggle}
            disabled={busy || !localId}
            accessibilityLabel={`Use ${providerName(provider)} in ${location}`}
          />
        </View>
      </View>
    </View>
  );
}

function ProviderConnectionActions({
  provider,
  environment,
  name,
  canRemove,
  fallback,
}: {
  provider: InstallationProvider;
  environment: InstallationEnvironment;
  name: string;
  canRemove: boolean;
  /** Shown when this environment has nothing to remove or restore. */
  fallback?: string;
}) {
  const client = useHostRuntimeClient(environment.serverId);
  const connected = useHostRuntimeIsConnected(environment.serverId);
  const supported = useHostFeature(environment.serverId, "providerCredentialRemoval");
  const { save } = useInstallationSettings();
  const location = environmentLabel(environment);
  const { config } = useDaemonConfig(environment.serverId);
  const retainedId = provider.bindings[environment.serverId];
  const removed = config?.providers[retainedId]?.removed === true;
  const reportConnectionLost = useConnectionLostReporter();
  const restoration = useMutation({
    mutationFn: async () => {
      if (!client || !connected) throw new Error(`Reconnect to ${location} and try again.`);
      await client.patchDaemonConfig({
        providers: { [retainedId]: { removed: false, enabled: false } },
      });
    },
    onError: reportConnectionLost,
  });
  const toast = useToast();
  useEffect(() => {
    if (restoration.isSuccess)
      toast.show("Connection restored. Sign in if needed, then turn it back on.");
  }, [restoration.isSuccess, toast]);
  const { mutate: restoreBinding } = restoration;
  const restore = useCallback(() => restoreBinding(), [restoreBinding]);
  const removal = useMutation({
    mutationFn: async () => {
      if (!client || !connected) throw new Error(`Reconnect to ${location} and try again.`);
      const snapshot = await requestInstallationSettings();
      const settings = snapshot.settings;
      const definition = settings?.providerDefinitions?.find((entry) => entry.id === provider.id);
      const localId = definition?.bindings[environment.serverId];
      if (!settings || !localId)
        throw new Error("This connection changed. Reload Settings before removing it.");
      const { plan } = await client.previewProviderRemoval(localId);
      let credentials = "Credentials stored by an external CLI will remain.";
      if (plan.credentials === "managed")
        credentials =
          "Its managed account directory, including credentials stored there, will be permanently deleted. Local connection settings remain for recovery.";
      else if (plan.credentials === "shared")
        credentials = `Credentials shared with ${plan.sharedWith.join(", ")} will remain.`;
      const confirmed = await confirmDialog({
        title: `Remove ${name} from ${location}?`,
        message: `${credentials} The connection stays available in other environments. It will be turned off in ${location}.`,
        confirmLabel: "Remove connection",
        destructive: true,
      });
      if (!confirmed) return;
      restoration.reset();
      const previous = settings.resourceExclusions[environment.serverId];
      await save({
        expectedRevision: snapshot.revision,
        settings: {
          resourceExclusions: {
            ...settings.resourceExclusions,
            [environment.serverId]: {
              ...previous,
              terminalProfileIds: previous?.terminalProfileIds ?? [],
              metadataProviderIds: previous?.metadataProviderIds ?? [],
              providerIds: [...new Set([...(previous?.providerIds ?? []), provider.id])],
            },
          },
        },
      });
      await client.removeProvider(localId, plan.revision);
    },
    onError: reportConnectionLost,
  });
  const { mutate } = removal;
  const remove = useCallback(() => mutate(), [mutate]);
  const error = hostRejection(removal.error ?? restoration.error);
  if (!canRemove && !removed)
    return fallback ? <Text style={settingsStyles.rowHint}>{fallback}</Text> : null;
  return (
    <View>
      <SettingsStatusLine
        testID={`shared-provider-remove-error-${provider.id}-${environment.serverId}`}
        message={error ? toErrorMessage(error) : null}
      />
      <View style={styles.removal}>
        {removed && supported ? (
          <Button
            variant="outline"
            disabled={!connected || restoration.isPending}
            onPress={restore}
            testID={`shared-provider-restore-${provider.id}-${environment.serverId}`}
          >
            {restoration.isPending ? "Restoring..." : `Restore in ${location}`}
          </Button>
        ) : null}
        {canRemove && supported ? (
          <Button
            variant="outline"
            disabled={!connected || removal.isPending}
            onPress={remove}
            testID={`shared-provider-remove-${provider.id}-${environment.serverId}`}
          >
            {removal.isPending ? "Removing..." : `Remove from ${location}`}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Profiles, defaults and removal
// ---------------------------------------------------------------------------

function ProviderProfiles({
  providerType,
  environments,
}: {
  providerType: string;
  environments: InstallationEnvironment[];
}) {
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId ?? null;
  const devId =
    environments.find((environment) => environment.kind === "container")?.serverId ?? null;
  const hostCatalog = useProvidersSnapshot(hostId);
  const devCatalog = useProvidersSnapshot(devId);
  const { config: hostConfig } = useDaemonConfig(hostId);
  const { config: devConfig } = useDaemonConfig(devId);
  // Profiles read models from whichever environment has this provider ready.
  const target =
    selectProfileCatalogSources([
      {
        serverId: hostId,
        entries: hostCatalog.entries,
        providers: hostConfig?.providers,
      },
      {
        serverId: devId,
        entries: devCatalog.entries,
        providers: devConfig?.providers,
      },
    ]).get(providerType) ?? (hostId ? { serverId: hostId, provider: providerType } : null);
  if (!target) return null;
  return <SharedProviderSection serverId={target.serverId} provider={target.provider} embedded />;
}

function RemoveProviderRow({
  family,
  snapshot,
  busy,
  saveAsync,
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  busy: boolean;
  saveAsync: SettingsSave;
}) {
  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: `Remove ${family.name} from Vorteo?`,
      message: `${family.name} stops appearing for new chats in every environment. Saved profiles, credentials and chat history stay, and you can restore it from Add provider.`,
      confirmLabel: "Remove provider",
      destructive: true,
    });
    if (!confirmed) return;
    await saveAsync({
      expectedRevision: snapshot.revision,
      settings: {
        providerDefinitions: snapshot.settings.providerDefinitions?.map((entry) =>
          entry.providerType === family.id
            ? {
                ...entry,
                removed: true,
                policy: { ...entry.policy, enabled: false },
              }
            : entry,
        ),
      },
    });
  }, [family, snapshot, saveAsync]);
  const onPress = useCallback(() => {
    // The page's save mutation already reports a failed removal.
    remove().catch(() => undefined);
  }, [remove]);
  // A quiet last row: removal is rare, so it is an outline button and red only in the confirmation.
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{`Remove ${family.name}`}</Text>
        <Text style={settingsStyles.rowHint}>
          Hides it for new chats everywhere. Restore it from Add provider.
        </Text>
      </View>
      <Button
        variant="outline"
        onPress={onPress}
        disabled={busy}
        accessibilityLabel={`Remove ${family.name} from Vorteo`}
        testID={`provider-detail-remove-${family.id}`}
      >
        Remove
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  connection: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  connectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // The name and status pressable; it grows outward from the text without moving its rail.
  disclosure: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: CONTROL_HEIGHTS.md,
    borderRadius: theme.borderRadius.md,
    ...hoverStyle({ color: theme.colors.foreground }, { color: theme.colors.foregroundMuted }),
  },
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  // Shrinks rather than fills, so the chevron sits right after the status text.
  identity: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  identityStacked: { flexDirection: "column", alignItems: "flex-start", gap: 0 },
  connectionTitle: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  status: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  statusAttention: { flexShrink: 1, color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  usageSummary: {
    flexShrink: 1,
    maxWidth: "35%",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  connectionDetails: { gap: theme.spacing[1] },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  usage: { gap: theme.spacing[2], marginTop: theme.spacing[1] },
  overflowHint: { flex: 1, marginTop: 0 },
  removal: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // An icon-only control the same height as the buttons and switch beside it: 32px where a
  // pointer drives it and a full 44px touch target in the compact layout.
  menuButton: {
    width: CONTROL_HEIGHTS.md,
    height: CONTROL_HEIGHTS.md,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    ...hoverStyle(
      { backgroundColor: theme.colors.interactionHighlight, color: theme.colors.foreground },
      { color: theme.colors.foregroundMuted },
    ),
  },
  menuButtonHovered: { backgroundColor: theme.colors.interactionHighlight },
}));

const reservedLayout1 = { minHeight: 240 } as const;
