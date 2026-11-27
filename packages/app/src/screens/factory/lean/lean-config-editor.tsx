import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import type { FactoryInvoke } from "../queue";
import { leanConfigDraft, type LeanConfigFields } from "./lean-config-model";
import {
  FACTORY_CONFIG_FILE,
  isRefusal,
  type LeanConfigRead,
  type LeanSource,
} from "./lean-factory-source";
import {
  useBuilderProviderOptions,
  useLeanConfig,
  useLeanFactoryReads,
} from "./lean-factory-queries";
import { useLeanBlockReason } from "./lean-overview";

/**
 * Edits the repository's Factory config: the primary machine and which provider builds. It
 * never writes the file. Saving shows the diff and then opens a pull request from the commit
 * the file was read at; the owner merges it.
 */
export function LeanConfigEditor({
  serverId,
  projectId,
  invoke,
  active,
  providerEntries,
}: {
  serverId: string;
  projectId: string;
  invoke: FactoryInvoke;
  active: boolean;
  /** Replaces the host's provider list, as on the demo page. */
  providerEntries?: readonly { provider: string; enabled: boolean }[];
}) {
  const { t } = useTranslation();
  const { source, config, error } = useLeanConfig({ serverId, projectId, invoke, enabled: active });
  const { view } = useLeanFactoryReads({
    serverId,
    projectId,
    invoke,
    enabled: active,
    polling: false,
  });
  const blocked = useLeanBlockReason("config-save", view?.readiness ?? null);
  if (error) return <Text style={styles.error}>{error.message}</Text>;
  if (!config) return <Text style={styles.muted}>{t("projectFactory.loading")}</Text>;
  return (
    <LeanConfigForm
      serverId={serverId}
      config={config}
      source={source}
      blocked={blocked}
      providerEntries={providerEntries}
    />
  );
}

type ProposeResult = { error: string } | { url: string; number: number } | null;

function LeanConfigForm({
  serverId,
  config,
  source,
  blocked,
  providerEntries,
}: {
  serverId: string;
  config: LeanConfigRead;
  source: LeanSource | null;
  providerEntries?: readonly { provider: string; enabled: boolean }[];
  /** Why saving is disabled now, or null. */
  blocked: string | null;
}) {
  const { t } = useTranslation();
  const [edits, setEdits] = useState<Partial<LeanConfigFields>>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ProposeResult>(null);
  const draft = useMemo(() => leanConfigDraft(config.file, edits), [config, edits]);
  const edit = useCallback((change: Partial<LeanConfigFields>) => {
    setResult(null);
    setEdits((current) => ({ ...current, ...change }));
  }, []);
  const propose = useCallback(async () => {
    if (!source || !config.commit || !draft.content || blocked) return;
    setPending(true);
    try {
      const response = await source.proposeConfig(config.commit, draft.content);
      setResult(
        isRefusal(response)
          ? { error: t("projectFactory.lean.refused", { reason: response.refused }) }
          : { url: response.url, number: response.pullRequest },
      );
    } catch (caught) {
      setResult({ error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setPending(false);
    }
  }, [blocked, config.commit, draft.content, source, t]);
  const pressPropose = useCallback(() => void propose(), [propose]);
  const changed = draft.changes.length > 0;
  return (
    <SettingsCard testID="factory-lean-config">
      <SettingsRow
        label={t("projectFactory.lean.config.title")}
        hint={t("projectFactory.lean.config.hint", { path: FACTORY_CONFIG_FILE })}
        error={
          draft.unreadable
            ? t("projectFactory.lean.config.unreadable", { error: draft.unreadable })
            : undefined
        }
      />
      {draft.fields ? (
        <ConfigFields
          serverId={serverId}
          providerEntries={providerEntries}
          fields={draft.fields}
          installations={config.installations}
          disabled={pending}
          onEdit={edit}
        />
      ) : null}
      {changed ? (
        <View style={styles.diff} testID="factory-lean-config-diff">
          {draft.changes.map((line) => (
            <Text key={line.key} style={line.kind === "add" ? styles.added : styles.removed}>
              {`${line.kind === "add" ? "+" : "-"} ${line.text}`}
            </Text>
          ))}
        </View>
      ) : null}
      {changed ? (
        <SettingsRow
          label={t("projectFactory.lean.config.propose")}
          hint={
            blocked ??
            (config.commit
              ? t("projectFactory.lean.config.proposeHint")
              : t("projectFactory.lean.config.noCommit"))
          }
          error={result && "error" in result ? result.error : undefined}
        >
          <Button
            size="sm"
            onPress={pressPropose}
            disabled={pending || !config.commit || !source || blocked !== null}
            testID="factory-lean-config-propose"
          >
            {t("projectFactory.lean.config.openPullRequest")}
          </Button>
        </SettingsRow>
      ) : null}
      {result && "url" in result ? <OpenedRow url={result.url} number={result.number} /> : null}
    </SettingsCard>
  );
}

function ConfigFields({
  serverId,
  providerEntries,
  fields,
  installations,
  disabled,
  onEdit,
}: {
  serverId: string;
  providerEntries?: readonly { provider: string; enabled: boolean }[];
  fields: LeanConfigFields;
  installations: LeanConfigRead["installations"];
  disabled: boolean;
  onEdit: (change: Partial<LeanConfigFields>) => void;
}) {
  const { t } = useTranslation();
  const machines = useMemo(
    () =>
      installations.map((installation) => ({
        value: installation.id,
        label: installation.friendlyName ?? installation.id,
      })),
    [installations],
  );
  const choices = useBuilderProviderOptions(serverId, fields.builderProvider, providerEntries);
  const providers = useMemo(
    () =>
      choices.map((choice) => {
        const name = t(`projectFactory.lean.config.providers.${choice.value}`, {
          defaultValue: choice.value,
        });
        return {
          value: choice.value,
          label: choice.available
            ? name
            : t("projectFactory.lean.config.notAvailable", { provider: name }),
        };
      }),
    [choices, t],
  );
  const setPrimary = useCallback((primary: string) => onEdit({ primary }), [onEdit]);
  const setProvider = useCallback(
    (builderProvider: string) => onEdit({ builderProvider }),
    [onEdit],
  );
  return (
    <>
      <SettingsSelect
        label={t("projectFactory.lean.config.primary")}
        hint={t("projectFactory.lean.config.primaryHint")}
        value={fields.primary ?? ""}
        options={machines}
        onValueChange={setPrimary}
        disabled={disabled || machines.length === 0}
      />
      <SettingsSelect
        label={t("projectFactory.lean.config.builder")}
        hint={t("projectFactory.lean.config.builderHint")}
        value={fields.builderProvider ?? ""}
        options={providers}
        onValueChange={setProvider}
        disabled={disabled}
      />
    </>
  );
}

function OpenedRow({ url, number }: { url: string; number: number }) {
  const { t } = useTranslation();
  const open = useCallback(() => void openExternalUrl(url), [url]);
  return (
    <SettingsRow
      label={t("projectFactory.lean.config.opened", { number })}
      hint={t("projectFactory.lean.config.openedHint")}
    >
      <Button size="sm" variant="outline" onPress={open}>
        {t("projectFactory.lean.open")}
      </Button>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  diff: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2], gap: 2 },
  added: { color: theme.colors.diffAddition, fontSize: theme.fontSize.sm, fontFamily: "monospace" },
  removed: {
    color: theme.colors.diffDeletion,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
}));
