import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonPermission, ServicePrincipal } from "@getpaseo/protocol/messages";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
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

export function ServiceAccessSection({ serverId }: { serverId: string }) {
  const available = useServiceAccessAvailable(serverId);
  if (!available) return null;
  return <ServiceAccessContent serverId={serverId} />;
}

function ServiceAccessContent({ serverId }: { serverId: string }) {
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
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

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
      setIssued({ label: principal.label, token });
      setCopied(false);
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

  const handleCreate = useCallback(() => {
    if (!canCreate) return;
    create.mutate({ label: trimmedLabel, permissions: [...READ_ONLY_PERMISSIONS] });
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

  const handleCopy = useCallback(() => {
    if (!issued) return;
    void Clipboard.setStringAsync(issued.token).then(() => setCopied(true));
  }, [issued]);

  const dismissIssued = useCallback(() => setIssued(null), []);

  const principals = query.data ?? [];

  return (
    <SettingsSection
      title="Service access"
      info="Credentials for scripts and services that connect without signing in. Each one holds only the permissions you choose."
    >
      {issued ? (
        <View style={[settingsStyles.card, styles.body]} testID="service-access-issued-token">
          <Text style={settingsStyles.rowTitle}>{`Credential for ${issued.label}`}</Text>
          <Text style={settingsStyles.rowHint}>
            Copy this token now. It will not be shown again.
          </Text>
          <Text selectable style={styles.token}>
            {issued.token}
          </Text>
          <View style={styles.actions}>
            <Button variant="outline" size="sm" onPress={handleCopy}>
              {copied ? "Copied" : "Copy token"}
            </Button>
            <Button variant="ghost" size="sm" onPress={dismissIssued}>
              Done
            </Button>
          </View>
        </View>
      ) : null}

      <View style={[settingsStyles.card, styles.body]} testID="service-access-create">
        <Field label="Name">
          <FormTextInput
            initialValue=""
            resetKey={resetKey}
            onChangeText={setLabel}
            placeholder="Backup script"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={120}
            editable={!create.isPending}
            accessibilityLabel="Credential name"
          />
        </Field>
        <Text style={settingsStyles.rowHint}>
          Read-only: can read projects, workspaces and agents. It cannot read files, run git or
          terminal commands, or change anything.
        </Text>
        <SettingsStatusLine message={create.error ? toErrorMessage(create.error) : null} />
        <View style={styles.actions}>
          <Button
            onPress={handleCreate}
            disabled={!canCreate}
            testID="service-access-create-submit"
          >
            {create.isPending ? "Creating..." : "Create credential"}
          </Button>
        </View>
      </View>

      <SettingsStatusLine message={query.error ? toErrorMessage(query.error) : null} />
      <SettingsStatusLine message={revoke.error ? toErrorMessage(revoke.error) : null} />
      {principals.length > 0 ? (
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
      ) : null}
    </SettingsSection>
  );
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
        <Button variant="outline" size="sm" onPress={handleRevoke} disabled={revoking}>
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
  mono: {
    fontFamily: theme.fontFamily.mono,
  },
  principalHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
