import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type {
  InstallationSettings,
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import {
  confirmAutomaticPrimary,
  useAutomaticPrimary,
  usePrimaryConnection,
} from "@/execution-installation/primary-connection";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { environmentLabel } from "./provider-connection-status";
import type { ProviderAccount } from "./shared-providers-model";

/** The connection's name for display: its label, else its provider type. */
function connectionName(definition: InstallationProvider): string {
  return definition.policy.label ?? definition.providerType;
}

/**
 * What runs system threads: Automatic and the account each environment picks now, or the chosen
 * connection with a way back to Automatic. Shown once the Host and coordinator support Automatic.
 */
export function PrimaryConnectionRow({
  definitions,
  environments,
}: {
  definitions: readonly InstallationProvider[];
  environments: readonly InstallationEnvironment[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { supported, primary, automatic, choose } = usePrimaryConnection();
  const [saving, setSaving] = useState(false);
  const switchToAutomatic = useCallback(async () => {
    setSaving(true);
    try {
      await confirmAutomaticPrimary({
        copy: {
          title: t("automaticPrimary.confirmTitle"),
          message: t("automaticPrimary.confirmMessage"),
          confirmLabel: t("automaticPrimary.use"),
          saved: t("automaticPrimary.saved"),
        },
        confirm: confirmDialog,
        choose,
        toast,
        describeError: toErrorMessage,
      });
    } finally {
      setSaving(false);
    }
  }, [choose, t, toast]);
  if (!supported || !automatic.supported) return null;
  const chosen = primary
    ? definitions.find((definition) => definition.id === primary.providerId)
    : undefined;
  return (
    <View style={styles.row} testID="shared-providers-primary">
      <View style={styles.content}>
        <Text style={settingsStyles.rowTitle}>{t("automaticPrimary.title")}</Text>
        {chosen ? <Text style={settingsStyles.rowHint}>{connectionName(chosen)}</Text> : null}
        {primary
          ? null
          : environments.map((environment) => (
              <AutomaticPick key={environment.serverId} environment={environment} />
            ))}
      </View>
      {primary ? (
        <Button
          variant="outline"
          size="sm"
          onPress={switchToAutomatic}
          disabled={saving}
          testID="shared-providers-use-automatic"
        >
          {t("automaticPrimary.use")}
        </Button>
      ) : null}
    </View>
  );
}

/** One environment's current Automatic pick; each environment's daemon picks on its own. */
function AutomaticPick({ environment }: { environment: InstallationEnvironment }) {
  const { t } = useTranslation();
  const { supported, current } = useAutomaticPrimary(environment.serverId);
  if (!supported || current === undefined) return null;
  const status = current
    ? t("automaticPrimary.current", { account: current.label })
    : t("automaticPrimary.none");
  return (
    <View style={styles.pick} testID={`shared-providers-automatic-${environment.serverId}`}>
      <Text style={settingsStyles.rowHint}>{environmentLabel(environment)}</Text>
      <Text style={settingsStyles.rowHint}>{status}</Text>
    </View>
  );
}

/**
 * The owner's switch for whether Automatic may run system threads on this connection. Off is
 * stored on every definition of the connection; on removes the key, since absent means it may.
 */
export function AutomaticEligibilityRow({
  account,
  snapshot,
  busy,
  save,
}: {
  account: ProviderAccount;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
}) {
  const { t } = useTranslation();
  const { automatic } = usePrimaryConnection();
  const eligible = account.definitions.every((entry) => entry.policy.automaticPrimary !== false);
  const toggle = useCallback(
    (value: boolean) => {
      const ids = new Set(account.definitions.map((entry) => entry.id));
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings.providerDefinitions?.map((entry) => {
            if (!ids.has(entry.id)) return entry;
            const { automaticPrimary: _previous, ...policy } = entry.policy;
            return { ...entry, policy: value ? policy : { ...policy, automaticPrimary: false } };
          }),
        },
      });
    },
    [account.definitions, snapshot, save],
  );
  if (!automatic.supported) return null;
  return (
    <View style={settingsStyles.card}>
      <View style={[settingsStyles.row, styles.eligible]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("automaticPrimary.eligible")}</Text>
        </View>
        <Switch
          value={eligible}
          onValueChange={toggle}
          disabled={busy}
          accessibilityLabel={t("automaticPrimary.eligible")}
          testID={`provider-automatic-eligible-${account.id}`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  content: { flex: 1, minWidth: 0 },
  pick: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  eligible: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));
