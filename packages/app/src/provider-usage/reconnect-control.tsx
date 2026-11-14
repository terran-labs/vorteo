import { AddClaudeAccountButton } from "./add-account";
import { claudeProviderConnectsToInstallation } from "./claude-setup-login";
import { ProviderLoginPanel, StatusLine, type ConnectionOutcome } from "./login-panel";
import type { ConnectionStatus } from "./claude-connection-status";
import { useClaudeAccountNeedsSignIn, useSharedInstallationSignIn } from "./use-provider-login";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { AlertTriangle } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ActionFooter } from "@/components/ui/action-footer";
import { CompactAccountButton } from "./compact-account-button";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { accountProviderKind, providerConnectionAction } from "./connection-action";
import { providerUsageQueryKey } from "./use-provider-usage";
import { retainLastKnownUsage } from "./usage-cache";
import type { ProviderUsage, ProviderUsageListPayload } from "./types";

import type { Theme } from "@/styles/theme";

const warningPalette = (theme: Theme) => ({ color: theme.colors.destructive });
const Warning = withUnistyles(AlertTriangle);
export function AccountDisconnectedIcon({ size = 18 }: { size?: number }) {
  return <Warning size={size} uniProps={warningPalette} />;
}
const reconnectIcon = <AccountDisconnectedIcon size={16} />;

type CheckState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "result"; tone: "success" | "error"; message: string };

export function ProviderReconnectControl({
  usage,
  serverId,
  name,
  providerId = usage?.providerId ?? "",
  onFinished,
  open: openProp,
  onOpenChange,
}: {
  usage: ProviderUsage | undefined;
  serverId: string | null;
  name: string;
  providerId?: string;
  /**
   * Called once when the dialog closes: connected when the account ended up signed in, failed
   * when the last attempt failed, otherwise cancelled.
   */
  onFinished?: (result: ConnectionOutcome) => void;
  /**
   * Controls the dialog from code, such as a "Reconnect all" sequence. Undefined leaves it to the
   * button. When set, the button and close ask through onOpenChange and the prop decides.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { claude, shared, action } = useConnectionAction(serverId, providerId, usage);
  // Opening snapshots the recovery method and title, so a reconnect that succeeds mid-dialog
  // cannot swap the body or rename the open dialog.
  const [opened, setOpened] = useState<{
    recovery: NonNullable<ProviderUsage["authRecovery"]>;
    title: string;
  } | null>(null);
  // Once used, the trigger stays rendered (as "Connection" when nothing is needed any more), so
  // closing the dialog can return focus to it.
  const [used, setUsed] = useState(false);
  const statusId = `${useId()}-status`;
  // The latest result inside the open dialog; reported once through onFinished on close.
  const outcome = useRef<Exclude<ConnectionOutcome, "cancelled"> | null>(null);
  const reportOutcome = useCallback((next: Exclude<ConnectionOutcome, "cancelled"> | null) => {
    outcome.current = next;
  }, []);
  const liveTitle = action ? `${action} ${name}` : `${name} connection`;
  const title = opened?.title ?? liveTitle;
  const header = useMemo(() => ({ title }), [title]);
  const { controlled, open, close } = useDialogSession({
    openProp,
    onOpenChange,
    onFinished,
    outcome,
    begin: useCallback(() => {
      setUsed(true);
      setOpened({
        recovery: usage?.authRecovery ?? { method: "device_code", instructions: "" },
        title: liveTitle,
      });
    }, [usage?.authRecovery, liveTitle]),
    end: useCallback(() => setOpened(null), []),
  });

  const modalFooter1 = useMemo(
    () => (
      <Button variant="outline" onPress={close} testID="provider-login-done">
        Done
      </Button>
    ),
    [close],
  );
  return (
    <>
      <ConnectionButton
        claude={claude}
        serverId={serverId}
        action={action}
        shared={shared}
        name={name}
        providerId={providerId}
        keep={used}
        onPress={open}
      />
      {opened !== null && (!controlled || openProp) ? (
        <AdaptiveModalSheet
          visible
          header={header}
          onClose={close}
          desktopMaxWidth={560}
          accessibilityLabel={title}
          accessibilityDescribedBy={statusId}
          testID="provider-reconnect-dialog"
          footer={modalFooter1}
        >
          <View style={styles.body}>
            {opened.recovery.method === "device_code" || claude || shared ? (
              <ProviderLoginPanel
                serverId={serverId}
                providerId={providerId}
                name={name}
                provider={claude ? "claude" : "codex"}
                onOutcome={reportOutcome}
                statusId={statusId}
              />
            ) : (
              <ManualRecovery
                serverId={serverId}
                usage={usage}
                instructions={opened.recovery.instructions}
                outcome={outcome}
                statusId={statusId}
              />
            )}
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}
/**
 * Opening and closing for the reconnect dialog, controlled by `openProp` when it is set. Each
 * opening reports onFinished exactly once, whether the dialog or the controlling code closes it.
 */
function useDialogSession({
  openProp,
  onOpenChange,
  onFinished,
  outcome,
  begin: onBegin,
  end,
}: {
  openProp: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  onFinished: ((result: ConnectionOutcome) => void) | undefined;
  outcome: { current: Exclude<ConnectionOutcome, "cancelled"> | null };
  begin(): void;
  end(): void;
}) {
  const controlled = openProp !== undefined;
  // True from opening until onFinished has reported.
  const session = useRef(false);
  const begin = useCallback(() => {
    session.current = true;
    outcome.current = null;
    onBegin();
  }, [outcome, onBegin]);
  const finish = useCallback(() => {
    end();
    if (!session.current) return;
    session.current = false;
    onFinished?.(outcome.current ?? "cancelled");
    outcome.current = null;
  }, [end, onFinished, outcome]);
  // Code-driven opening starts in the same state as a button press; closing from code reports too.
  useEffect(() => {
    if (openProp === true && !session.current) begin();
    else if (openProp === false && session.current) finish();
  }, [openProp, begin, finish]);
  const open = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (controlled) onOpenChange?.(true);
      else begin();
    },
    [controlled, onOpenChange, begin],
  );
  const close = useCallback(() => {
    if (controlled) onOpenChange?.(false);
    finish();
  }, [controlled, onOpenChange, finish]);
  return { controlled, open, close };
}

/**
 * Recovery the dialog cannot run itself: the provider's own instructions, then a check that
 * refreshes usage to confirm the account works again.
 */
function ManualRecovery({
  serverId,
  usage,
  instructions,
  outcome,
  statusId,
}: {
  serverId: string | null;
  usage: ProviderUsage | undefined;
  instructions: string;
  outcome: { current: Exclude<ConnectionOutcome, "cancelled"> | null };
  statusId: string;
}) {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const cache = useQueryClient();
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const pending = check.kind === "pending";
  const checkConnection = useCallback(async () => {
    if (!client || !connected || !usage || pending) return;
    setCheck({ kind: "pending" });
    try {
      const payload = await client.listProviderUsage({ forceRefresh: true });
      const account = payload.providers.find((entry) => entry.providerId === usage.providerId);
      const key = providerUsageQueryKey(serverId);
      cache.setQueryData(
        key,
        retainLastKnownUsage(payload, cache.getQueryData<ProviderUsageListPayload>(key)),
      );
      let result: CheckState = {
        kind: "result",
        tone: "error",
        message: "Could not verify the connection. Try again shortly.",
      };
      outcome.current = "failed";
      if (account?.authRecovery)
        result = {
          kind: "result",
          tone: "error",
          message: "Still signed out. Finish the steps below, then check again.",
        };
      else if (account?.status === "available") {
        result = { kind: "result", tone: "success", message: "Connected" };
        outcome.current = "connected";
      }
      setCheck(result);
    } catch {
      outcome.current = "failed";
      setCheck({ kind: "result", tone: "error", message: "Could not reach the host. Try again." });
    }
  }, [client, connected, usage, pending, cache, serverId, outcome]);
  return (
    <>
      <StatusLine status={manualCheckStatus(connected, check)} nativeID={statusId} />
      <Text selectable style={styles.text}>
        {instructions}
      </Text>
      <ActionFooter style={styles.actions}>
        <Button
          variant="default"
          disabled={pending || !connected}
          // Keeps focus while the check runs instead of dropping it to the page.
          focusableWhenDisabled
          onPress={checkConnection}
        >
          Check connection
        </Button>
      </ActionFooter>
    </>
  );
}

/** Which connection action an account row offers, and whether it signs in through the installation. */
function useConnectionAction(
  serverId: string | null,
  providerId: string,
  usage: ProviderUsage | undefined,
) {
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const claude = accountProviderKind(providerId, config?.providers) === "claude";
  // Installation accounts always offer their connection panel, which shows Dev synchronization.
  const shared = useSharedInstallationSignIn(serverId, claude ? "claude" : "codex", providerId);
  // The coordinator knows when a named Claude account's Host grant is gone, even while its last
  // usage reading still looks fine.
  const coordinatorNeedsSignIn = useClaudeAccountNeedsSignIn(claude ? serverId : null, providerId);
  const action = coordinatorNeedsSignIn
    ? "Reconnect"
    : providerConnectionAction({
        providerId,
        providers: config?.providers,
        usage,
        snapshot: entries?.find((entry) => entry.provider === providerId),
      });
  return { claude, shared, action };
}

function ConnectionButton({
  claude,
  serverId,
  action,
  shared,
  name,
  providerId,
  keep,
  onPress,
}: {
  keep: boolean;
  claude: boolean;
  serverId: string | null;
  action: "Connect" | "Reconnect" | null;
  shared: boolean;
  name: string;
  providerId: string;
  onPress(event: GestureResponderEvent): void;
}) {
  if (claude && shared && serverId && !claudeProviderConnectsToInstallation(providerId))
    return <AddClaudeAccountButton serverId={serverId} label="Add account" />;
  if (!action && !shared && !keep) return null;
  const label = action ?? "Connection";
  return (
    <CompactAccountButton
      // A needed Connect or Reconnect is the row's primary action; an open connection is not.
      // `variant` takes effect with the providers worker's CompactAccountButton change.
      variant={action ? "default" : "outline"}
      leftIcon={action === "Reconnect" ? reconnectIcon : undefined}
      accessibilityLabel={`${name}: ${label} account`}
      testID={`provider-${label.toLowerCase()}-${providerId}`}
      onPress={onPress}
    >
      {label}
    </CompactAccountButton>
  );
}

function manualCheckStatus(connected: boolean, check: CheckState): ConnectionStatus {
  if (!connected)
    return { tone: "error", text: "Connection to the host lost. Reconnect to check this account." };
  if (check.kind === "pending") return { tone: "busy", text: "Checking the connection..." };
  if (check.kind === "result") return { tone: check.tone, text: check.message };
  return {
    tone: "error",
    text: "Sign-in was rejected. Follow these steps, then check the connection.",
  };
}

const styles = StyleSheet.create((theme) => ({
  actions: { paddingTop: 0 },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  // The sheet owns the content inset; the body only spaces its parts.
  body: { gap: theme.spacing[4] },
}));
