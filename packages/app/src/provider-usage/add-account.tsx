import { OwnerSettingsGate } from "@/components/settings/owner-lock";
import { createSharedAccountDefinition } from "@/execution-installation/account-creation";
import {
  requestInstallationSettings,
  useInstallationSettings,
} from "@/execution-installation/settings";
import {
  installationHasDev,
  readExecutionInstallation,
  findInstallationEnvironment,
} from "@/execution-installation/policy";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useSessionStore } from "@/stores/session-store";
import {
  refreshAndApplyProvidersSnapshot,
  useProvidersSnapshot,
} from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { daemonConfigQueryKey } from "@/data/daemon-config";

import { ProviderLoginPanel, type ConnectionOutcome } from "./login-panel";
import { LiveAnnouncement } from "@/components/ui/visually-hidden";
import { claudeFullSignInAvailable } from "./claude-setup-login";
import { openAccountForm, suggestedAccountName, type CreatedCodexAccount } from "./account-form";
import { useProviderUsage } from "./use-provider-usage";
import {
  ACCOUNT_PROVIDER_LABELS,
  describeExistingConnection,
  existingConnections,
  type ExistingConnection,
} from "./existing-connection";

interface AddAccountProps {
  serverId: string;
  provider: "codex" | "claude";
  onCreated?: (account: CreatedCodexAccount) => void;
}
type AccountButtonProps = Omit<AddAccountProps, "provider"> & {
  catalog?: boolean;
  /** Replaces the default button text, for example "Connect" on the accounts first screen. */
  label?: string;
  /**
   * Called once when the dialog closes: connected when the new account signed in, failed when
   * its last sign-in attempt failed, otherwise cancelled.
   */
  onFinished?: (result: ConnectionOutcome) => void;
  style?: StyleProp<ViewStyle>;
};
export function AddCodexAccountButton(props: AccountButtonProps) {
  return <AddAccountButton {...props} provider="codex" />;
}
export function AddClaudeAccountButton(props: AccountButtonProps) {
  return <AddAccountButton {...props} provider="claude" />;
}

function AddAccountButton(props: Parameters<typeof UnlockedAddAccountButton>[0]) {
  return (
    <OwnerSettingsGate
      title="Add provider account"
      required={findInstallationEnvironment(readExecutionInstallation(), props.serverId) !== null}
    >
      <UnlockedAddAccountButton {...props} />
    </OwnerSettingsGate>
  );
}

function UnlockedAddAccountButton({
  catalog = false,
  label,
  style,
  onFinished,
  ...props
}: AddAccountProps & Omit<AccountButtonProps, keyof AddAccountProps>) {
  const installation = readExecutionInstallation();
  const belongsToInstallation = installation?.environments.some(
    (environment) => environment.serverId === props.serverId,
  );
  const hostId = installation?.environments.find(
    (environment) => environment.kind === "host",
  )?.serverId;
  const serverId = belongsToInstallation && hostId ? hostId : props.serverId;
  const [open, setOpen] = useState(false);
  const text =
    label ?? (catalog ? "Add" : `Add ${ACCOUNT_PROVIDER_LABELS[props.provider]} account`);
  // The sign-in panel's latest result, reported once through onFinished on close.
  const outcome = useRef<Exclude<ConnectionOutcome, "cancelled"> | null>(null);
  const reportOutcome = useCallback((next: Exclude<ConnectionOutcome, "cancelled"> | null) => {
    outcome.current = next;
  }, []);
  const show = useCallback(() => {
    outcome.current = null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    onFinished?.(outcome.current ?? "cancelled");
    outcome.current = null;
  }, [onFinished]);

  return (
    <>
      <Button
        variant={catalog ? "default" : "outline"}
        size={catalog ? "sm" : "md"}
        style={style}
        onPress={show}
        accessibilityLabel={accessibleAccountLabel(text, ACCOUNT_PROVIDER_LABELS[props.provider])}
        testID={`add-${props.provider}-account`}
      >
        {text}
      </Button>
      {open ? (
        <AccountSheet
          key={serverId}
          {...props}
          serverId={serverId}
          onClose={close}
          onOutcome={reportOutcome}
        />
      ) : null}
    </>
  );
}

/**
 * Short visible labels such as "Add" or "Connect" repeat across provider rows; the spoken name
 * always says which provider the new account is for.
 */
function accessibleAccountLabel(text: string, provider: string): string {
  if (text.includes(provider)) return text;
  if (text.endsWith(" account")) return `${text.slice(0, -" account".length)} ${provider} account`;
  return `${text} ${provider} account`;
}

interface SheetExtras {
  /** Spoken once: creation, a creation error, or a lost host connection. */
  announcement?: string | null;
  /** The `nativeID` that describes the dialog, such as the sign-in status line. */
  describedBy?: string;
}

type RenderSheet = (body: ReactNode, footer: ReactNode, extras?: SheetExtras) => ReactNode;

interface SheetCallbacks {
  onClose: () => void;
  onOutcome: (outcome: Exclude<ConnectionOutcome, "cancelled"> | null) => void;
}

function AccountSheet({ onClose, onOutcome, ...props }: AddAccountProps & SheetCallbacks) {
  const { config } = useDaemonConfig(props.serverId);
  const existing = useExistingConnections(props.serverId, props.provider);
  const another = existing.connections.length > 0;
  const header = useMemo(
    () => ({
      title: `Add ${another ? "another " : ""}${ACCOUNT_PROVIDER_LABELS[props.provider]} account`,
    }),
    [another, props.provider],
  );
  const supported = useHostFeature(
    props.serverId,
    props.provider === "claude" ? "claudeAccountCreation" : "codexAccountCreation",
  );
  const permissions = useSessionStore(
    (state) => state.sessions[props.serverId]?.serverInfo?.permissions,
  );
  const canManage = permissions?.includes("daemon.manage") !== false;
  const renderSheet = useCallback(
    (body: ReactNode, footer: ReactNode, extras: SheetExtras = {}) => (
      <AdaptiveModalSheet
        visible
        header={header}
        onClose={onClose}
        desktopMaxWidth={520}
        accessibilityLabel={header.title}
        accessibilityDescribedBy={extras.describedBy}
        testID={`add-${props.provider}-account-dialog`}
        footer={footer}
      >
        <View style={styles.body}>
          {body}
          {/* Same position in every step, so the region exists before each message. */}
          <LiveAnnouncement message={extras.announcement ?? null} />
        </View>
      </AdaptiveModalSheet>
    ),
    [header, onClose, props.provider],
  );
  let message: string | null = null;
  if (!supported) message = "Update this host to add accounts here.";
  else if (!canManage)
    message = "This connection needs permission to manage the host before it can add an account.";
  if (!message && config) {
    return (
      <AccountForm
        {...props}
        existing={existing}
        initialName={suggestedAccountName(config.providers, props.provider)}
        onClose={onClose}
        onOutcome={onOutcome}
        renderSheet={renderSheet}
      />
    );
  }
  return renderSheet(<Text style={styles.text}>{message ?? "Loading accounts..."}</Text>, null);
}

function useAccountForm({
  serverId,
  onCreated,
  initialName,
  provider,
  signIn,
}: AddAccountProps & { initialName: string; signIn: "full" | undefined }) {
  const client = useHostRuntimeClient(serverId);
  const cache = useQueryClient();
  const live = useRef({ client, onCreated, signIn });
  live.current = { client, onCreated, signIn };
  const [model] = useState(() =>
    openAccountForm(globalThis.crypto.randomUUID(), {
      initialName,
      async create(creationId, name) {
        const current = live.current.client;
        if (!current) throw new Error("Reconnect to the host and try again.");
        const accountSignIn = provider === "claude" ? live.current.signIn : undefined;
        const installation = readExecutionInstallation();
        if (installation?.environments.some((environment) => environment.serverId === serverId)) {
          const shared = await createSharedAccountDefinition(
            {
              creationId,
              name,
              provider,
              serverIds: installation.environments.map((environment) => environment.serverId),
              ...(accountSignIn ? { signIn: accountSignIn } : {}),
            },
            { read: () => requestInstallationSettings(), save: requestInstallationSettings },
          );
          name = shared.name;
          await cache.invalidateQueries({
            queryKey: ["installation-settings", installation.installationId],
          });
        }
        const account =
          provider === "claude"
            ? await current.createClaudeAccount(creationId, name, accountSignIn)
            : await current.createCodexAccount(creationId, name);
        await cache.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
        await refreshAndApplyProvidersSnapshot({
          client: current,
          queryClient: cache,
          serverId,
          cwd: null,
          providers: [account.providerId],
        });
        return account;
      },
      created(account) {
        live.current.onCreated?.(account);
      },
    }),
  );
  useEffect(() => () => model.close(), [model]);
  return { model, state: useSyncExternalStore(model.subscribe, model.getState, model.getState) };
}

function AccountForm({
  onClose,
  onOutcome,
  renderSheet,
  existing,
  ...props
}: AddAccountProps &
  SheetCallbacks & {
    initialName: string;
    renderSheet: RenderSheet;
    existing: ExistingConnections;
  }) {
  const fullAvailable = useClaudeFullSignInAvailable(props.serverId, props.provider);
  const [signInChoice, setSignInChoice] = useState<"full" | "setup-token">("full");
  const signIn = fullAvailable && signInChoice === "full" ? "full" : undefined;
  const { model, state } = useAccountForm({ ...props, signIn });
  const connected = useHostRuntimeIsConnected(props.serverId);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const id = useId();
  const statusId = `${id}-status`;
  const typeHintId = `${id}-type-hint`;
  if (state.phase === "created")
    return renderSheet(
      <ProviderLoginPanel
        serverId={props.serverId}
        providerId={state.account.providerId}
        name={state.account.name}
        provider={props.provider}
        onOutcome={onOutcome}
        focusSignIn
        statusId={statusId}
      />,
      <Button variant="outline" onPress={onClose} testID={`${props.provider}-account-done`}>
        Done
      </Button>,
      { announcement: `${state.account.name} added. Sign in to finish.`, describedBy: statusId },
    );
  const creating = state.phase === "creating";
  const another = existing.connections.length > 0;
  return renderSheet(
    <>
      {another ? <ExistingConnectionNotice provider={props.provider} existing={existing} /> : null}
      <Field label={another ? "Additional account name" : "Account name"}>
        <FormTextInput
          initialValue={state.name}
          onChangeText={model.setName}
          editable={!creating}
          size={size}
          testID={`${props.provider}-account-name`}
        />
      </Field>
      {fullAvailable ? (
        <Field label="Sign-in type">
          <SegmentedControl
            options={[
              { value: "full", label: "Full sign-in", testID: "claude-sign-in-full" },
              { value: "setup-token", label: "Setup token", testID: "claude-sign-in-setup" },
            ]}
            value={signInChoice}
            onValueChange={setSignInChoice}
            accessibilityLabel="Sign-in type"
            aria-describedby={typeHintId}
            testID="claude-sign-in-type"
          />
          <Text nativeID={typeHintId} style={styles.muted}>
            {signInChoice === "full"
              ? `Shows usage, and the Host keeps the sign-in fresh${installationHasDev(readExecutionInstallation()) ? " for Host and Dev" : ""}. The type can't be changed later.`
              : "Uses a long-lived token without usage readings. The type can't be changed later."}
          </Text>
        </Field>
      ) : null}
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      {!connected ? (
        <Text style={styles.error}>Reconnect to the host to add this account.</Text>
      ) : null}
    </>,
    <Button
      onPress={model.submit}
      // Loading keeps the focused button focusable while the account is created.
      disabled={!connected}
      focusableWhenDisabled
      loading={creating}
      testID={`${props.provider}-account-create`}
    >
      {another ? "Create additional account" : "Create account"}
    </Button>,
    {
      announcement:
        state.error ?? (connected ? null : "Reconnect to the host to add this account."),
    },
  );
}

interface ExistingConnections {
  connections: ExistingConnection[];
  where: "Host" | "host";
}

/**
 * Connections the owner already has for this provider, read where sign-ins run: the Host in an
 * installation, otherwise this host. Shown before the form so a second account is a choice.
 */
function useExistingConnections(
  serverId: string,
  provider: "codex" | "claude",
): ExistingConnections {
  const installation = readExecutionInstallation();
  const inInstallation = Boolean(
    installation?.environments.some((environment) => environment.serverId === serverId),
  );
  const host = inInstallation
    ? (installation?.environments.find((environment) => environment.kind === "host")?.serverId ??
      serverId)
    : serverId;
  const settings = useInstallationSettings(inInstallation);
  const { view } = useProviderUsage(host);
  const { entries } = useProvidersSnapshot(host);
  const definitions = settings.data?.settings?.providerDefinitions;
  const usage = view.kind === "ready" ? view.payload.providers : undefined;
  const connections = useMemo(
    () =>
      existingConnections({
        provider,
        definitions: inInstallation ? (definitions ?? []) : undefined,
        serverId: host,
        usage,
        entries,
      }),
    [provider, inInstallation, definitions, host, usage, entries],
  );
  return { connections, where: inInstallation ? "Host" : "host" };
}

function ExistingConnectionNotice({
  provider,
  existing,
}: {
  provider: "codex" | "claude";
  existing: ExistingConnections;
}) {
  const label = ACCOUNT_PROVIDER_LABELS[provider];
  const names = existing.connections
    .map((connection) => describeExistingConnection(connection, existing.where))
    .join(", ");
  return (
    <View style={styles.notice} testID={`${provider}-existing-connection`}>
      <Text style={styles.text}>{`${label} is already connected: ${names}.`}</Text>
      <Text style={styles.muted}>
        {`This adds a second, separate ${label} account with its own sign-in. Close this if you meant to use the existing connection.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The sheet owns the content inset; the body only spaces its parts.
  body: { gap: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  notice: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
}));

/**
 * Full sign-in needs the coordinator's Host refresh and every environment's daemon support:
 * older daemons reject the whole shared settings authority when a definition carries it.
 */
function useClaudeFullSignInAvailable(serverId: string, provider: "codex" | "claude") {
  const installation = readExecutionInstallation();
  const sharedClaude =
    provider === "claude" &&
    Boolean(installation?.environments.some((environment) => environment.serverId === serverId));
  // The descriptor is re-read each render; key the list on its contents, not its identity.
  const serverKey = installation?.environments
    .map((environment) => environment.serverId)
    .join("\n");
  const serverIds = useMemo(() => (serverKey ? serverKey.split("\n") : []), [serverKey]);
  const support = useHostFeatureMap(serverIds, "claudeFullSignIn");
  const daemonsReady = serverIds.length > 0 && serverIds.every((id) => support.get(id) === true);
  const coordinator = useFetchQuery({
    queryKey: ["claude-full-sign-in", installation?.installationId],
    queryFn: claudeFullSignInAvailable,
    enabled: sharedClaude && daemonsReady,
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  return sharedClaude && daemonsReady && coordinator.data === true;
}
