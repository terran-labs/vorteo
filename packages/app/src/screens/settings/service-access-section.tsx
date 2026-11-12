import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isWeb } from "@/constants/platform";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonPermission, ServicePrincipal } from "@getpaseo/protocol/messages";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import { JoinedField } from "@/components/settings/joined-field";
import { SettingsAdvancedGroup } from "@/components/settings/advanced-group";
import { SettingsListSummary } from "@/components/settings/list-summary";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

// Hosts issue only read-only service credentials until workspace-scoped grants exist.
const READ_ONLY_PERMISSIONS: DaemonPermission[] = ["workspace.read"];

function useServiceAccessAvailable(serverId: string): boolean {
  const supported = useHostFeature(serverId, "servicePrincipals");
  const canManage = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.permissions?.includes("access.manage") === true,
  );
  return supported && canManage;
}

interface IssuedToken {
  label: string;
  token: string;
}

export function ServiceAccessSection({ serverId }: { serverId: string }) {
  const available = useServiceAccessAvailable(serverId);
  // The one-time token lives here, outside the disclosure, so collapsing the group or clearing a
  // search that opened it cannot lose a token that is never shown again.
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const dismissIssued = useCallback(() => setIssued(null), []);
  if (!available) return null;
  // Credentials for scripts are rarely managed, so they wait behind a closed disclosure.
  return (
    <>
      {issued ? (
        <IssuedTokenCard key={issued.token} issued={issued} onDone={dismissIssued} />
      ) : null}
      <SettingsAdvancedGroup title="Service access" testID="service-access-advanced">
        <ServiceAccessContent serverId={serverId} onIssued={setIssued} />
      </SettingsAdvancedGroup>
    </>
  );
}

// Focusable from code only. React Native's Text types omit `tabIndex`; React Native Web renders it.
const FOCUS_TARGET = { tabIndex: -1 } as object;

/** The new credential's token, shown once. Focus moves to it so screen readers hear it arrive. */
function IssuedTokenCard({ issued, onDone }: { issued: IssuedToken; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const heading = useRef<Text>(null);
  useEffect(() => {
    if (isWeb) (heading.current as unknown as HTMLElement | null)?.focus?.();
  }, [issued.token]);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(issued.token).then(() => setCopied(true));
  }, [issued.token]);
  return (
    <SettingsSection title="New credential">
      <View style={[settingsStyles.card, styles.body]} testID="service-access-issued-token">
        <Text ref={heading} {...FOCUS_TARGET} style={settingsStyles.rowTitle}>
          {`Credential for ${issued.label}`}
        </Text>
        <Text style={settingsStyles.rowHint}>Copy this token now. It will not be shown again.</Text>
        <Text selectable style={styles.token}>
          {issued.token}
        </Text>
        <View style={styles.actions}>
          <Button variant="outline" onPress={copy}>
            {copied ? "Copied" : "Copy token"}
          </Button>
          <Button variant="ghost" onPress={onDone}>
            Done
          </Button>
        </View>
        {/* Mounted before the first copy, so "Copied" is announced. */}
        <Text accessibilityLiveRegion="polite" aria-live="polite" style={styles.visuallyHidden}>
          {copied ? "Token copied" : ""}
        </Text>
      </View>
    </SettingsSection>
  );
}

function ServiceAccessContent({
  serverId,
  onIssued,
}: {
  serverId: string;
  onIssued: (issued: IssuedToken) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["host", serverId, "service-principals"] as const, [serverId]);
  const query = useFetchQuery<ServicePrincipal[], Error>({
    queryKey,
    queryFn: async () => {
      if (!client) throw new Error("Reconnect to this host to manage service access.");
      const result = await client.listServicePrincipals();
      if (result.error) throw new Error(result.error);
      return result.principals;
    },
    enabled: client !== null,
    retry: false,
    dataShape: "list",
    staleTimeMs: 0,
  });

  const [label, setLabel] = useState("");
  const [resetKey, setResetKey] = useState(0);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  const create = useMutation({
    mutationFn: async (input: { label: string; permissions: DaemonPermission[] }) => {
      if (!client) throw new Error("Reconnect to this host to create a credential.");
      const result = await client.createServicePrincipal(input);
      if (result.error || !result.principal || !result.token) {
        throw new Error(result.error ?? "The host did not return a credential.");
      }
      return { principal: result.principal, token: result.token };
    },
    onSuccess: ({ principal, token }) => {
      onIssued({ label: principal.label, token });
      setLabel("");
      setResetKey((key) => key + 1);
      void invalidate();
    },
  });

  const revoke = useMutation({
    mutationFn: async (principalId: string) => {
      if (!client) throw new Error("Reconnect to this host to revoke a credential.");
      const result = await client.revokeServicePrincipal(principalId);
      if (result.error) throw new Error(result.error);
      return result.principal;
    },
    onSettled: () => void invalidate(),
  });

  const trimmedLabel = label.trim();
  const canCreate = trimmedLabel.length > 0 && !create.isPending;

  // Enter then a click can land before `isPending` re-renders; one request at a time.
  const creating = useRef(false);
  const handleCreate = useCallback(() => {
    if (!canCreate || creating.current) return;
    creating.current = true;
    create.mutate(
      { label: trimmedLabel, permissions: [...READ_ONLY_PERMISSIONS] },
      {
        onSettled: () => {
          creating.current = false;
        },
      },
    );
  }, [canCreate, create, trimmedLabel]);

  const handleRevoke = useCallback(
    (principal: ServicePrincipal) => {
      void confirmDialog({
        title: `Revoke ${principal.label}?`,
        message: "Anything using this credential loses access immediately. This cannot be undone.",
        confirmLabel: "Revoke",
        destructive: true,
      }).then((confirmed) => {
        if (confirmed) revoke.mutate(principal.id);
        return undefined;
      });
    },
    [revoke],
  );

  const principals = query.data ?? [];

  return (
    <SettingsSection
      title="Service access"
      info="Credentials for scripts and services that connect without signing in. Each one holds only the permissions you choose."
    >
      <View style={[settingsStyles.card, styles.body]} testID="service-access-create">
        <Field label="Name">
          {/* Creating issues a token, so it stays an explicit submit. */}
          <JoinedField
            label="Credential name"
            initialValue=""
            resetKey={resetKey}
            onChangeText={setLabel}
            onSubmit={handleCreate}
            submitLabel="Create"
            submitAccessibilityLabel="Create credential"
            submitDisabled={trimmedLabel.length === 0}
            busy={create.isPending}
            error={create.error ? toErrorMessage(create.error) : null}
            placeholder="Backup script"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={120}
            testID="service-access-create-name"
            submitTestID="service-access-create-submit"
          />
        </Field>
        <Text style={settingsStyles.rowHint}>
          Read-only: can read projects, workspaces and agents. It cannot read files, run git or
          terminal commands, or change anything.
        </Text>
      </View>

      <SettingsStatusLine message={query.error ? toErrorMessage(query.error) : null} />
      <SettingsStatusLine message={revoke.error ? toErrorMessage(revoke.error) : null} />
      {principals.length > 0 ? (
        <SettingsListSummary
          title="Service credentials"
          count={principals.length}
          noun={CREDENTIAL_NOUN}
          preview={principals.map((principal) => principal.label)}
          detail={revokedDetail(principals)}
          testID="service-access-summary"
        >
          <View style={settingsStyles.card} testID="service-access-list">
            {principals.map((principal, index) => (
              <PrincipalRow
                key={principal.id}
                principal={principal}
                showBorder={index > 0}
                revoking={revoke.isPending && revoke.variables === principal.id}
                onRevoke={handleRevoke}
              />
            ))}
          </View>
        </SettingsListSummary>
      ) : null}
    </SettingsSection>
  );
}

const CREDENTIAL_NOUN = { one: "credential", other: "credentials" };

function revokedDetail(principals: readonly ServicePrincipal[]): string | undefined {
  const revoked = principals.filter((principal) => principal.revokedAt !== null).length;
  return revoked > 0 ? `${revoked} revoked` : undefined;
}

function formatCreated(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function PrincipalRow({
  principal,
  showBorder,
  revoking,
  onRevoke,
}: {
  principal: ServicePrincipal;
  showBorder: boolean;
  revoking: boolean;
  onRevoke: (principal: ServicePrincipal) => void;
}) {
  const active = principal.revokedAt === null;
  const handleRevoke = useCallback(() => onRevoke(principal), [onRevoke, principal]);
  return (
    <View
      style={[settingsStyles.row, showBorder && settingsStyles.rowBorder]}
      testID={`service-access-principal-${principal.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <View style={styles.principalHeading}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {principal.label}
          </Text>
          <StatusBadge
            label={active ? "Active" : "Revoked"}
            variant={active ? "success" : "muted"}
          />
        </View>
        <Text style={[settingsStyles.rowHint, styles.mono]}>
          {principal.permissions.join(", ")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {active
            ? `Created ${formatCreated(principal.createdAt)}`
            : `Created ${formatCreated(principal.createdAt)}, revoked ${formatCreated(principal.revokedAt ?? "")}`}
        </Text>
      </View>
      {active ? (
        <Button
          variant="outline"
          onPress={handleRevoke}
          disabled={revoking}
          accessibilityLabel={`Revoke ${principal.label}`}
        >
          {revoking ? "Revoking..." : "Revoke"}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  token: {
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  // Read by screen readers, not shown.
  visuallyHidden: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
  mono: {
    fontFamily: theme.fontFamily.mono,
  },
  principalHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
