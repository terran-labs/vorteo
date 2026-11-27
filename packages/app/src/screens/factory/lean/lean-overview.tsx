import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ActionFooter } from "@/components/ui/action-footer";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import { useToast } from "@/contexts/toast-context";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openExternalUrl } from "@/utils/open-external-url";
import { Panel } from "../overview-kit";
import type { FactoryInvoke } from "../queue";
import {
  isRefusal,
  leanQueryKeys,
  type LeanActivityEntry,
  type LeanSource,
  type LeanView,
} from "./lean-factory-source";
import { useLeanActivity, useLeanFactoryReads } from "./lean-factory-queries";
import {
  leanActionBlock,
  leanHealthAlerts,
  leanMachineName,
  leanNeedsYou,
  leanReleases,
  type LeanNeedsYouItem,
  type LeanOwnerAction,
  type LeanReleaseAction,
  type LeanReleaseRow,
} from "./lean-model";

/** The owner action each Needs you item offers; questions are answered in the Lead's thread. */
const NEEDS_YOU_ACTION: Record<LeanNeedsYouItem["kind"], LeanOwnerAction | null> = {
  "beta-notice": "hold",
  approval: "approval",
  question: null,
  promote: "promote",
};

const ReadinessContext = createContext<LeanView["readiness"] | null>(null);

/** The short reason an owner action is disabled now, or null when the owner may take it. */
export function useLeanBlockReason(
  action: LeanOwnerAction | null | undefined,
  readiness?: LeanView["readiness"] | null,
): string | null {
  const { t } = useTranslation();
  const fromPage = useContext(ReadinessContext);
  if (!action) return null;
  const block = leanActionBlock(readiness ?? fromPage, action);
  return block ? t(`projectFactory.lean.blocked.${block}`) : null;
}

/**
 * A lean Factory's overview: what needs the owner, the production release, betas to promote,
 * earlier releases to roll back to, open previews, activity and health. Promote and Roll back
 * act on one exact release after the owner confirms its version in the app's own dialog.
 */
export function LeanFactoryOverview({
  serverId,
  projectId,
  state,
  invoke,
  active,
}: {
  serverId: string;
  projectId: string;
  state: ProjectFactoryState;
  invoke: FactoryInvoke;
  active: boolean;
}) {
  const { t } = useTranslation();
  const reads = useLeanFactoryReads({
    serverId,
    projectId,
    invoke,
    enabled: active,
    polling: active,
  });
  const activity = useLeanActivity({ serverId, projectId, invoke, enabled: active });
  const { status, view, source } = reads;
  const [confirming, setConfirming] = useState<LeanReleaseAction | null>(null);
  const needsYou = useMemo(() => leanNeedsYou(status, view), [status, view]);
  const releases = useMemo(() => (view ? leanReleases(view) : null), [view]);
  const alerts = useMemo(() => leanHealthAlerts(status, view), [status, view]);
  const leadAgentId = state.roles.find((role) => role.role === "factory-intake")?.agentId ?? null;
  const closeConfirm = useCallback(() => setConfirming(null), []);
  const promoteNewest = useCallback(() => {
    const newest = releases?.betas.find((row) => row.action?.kind === "promote");
    if (newest?.action) setConfirming(newest.action);
  }, [releases]);
  const productionRow = useMemo(
    () => (releases?.production ? { event: releases.production, action: null } : null),
    [releases],
  );

  if (!view) {
    return <Text style={styles.muted}>{t("projectFactory.loading")}</Text>;
  }
  return (
    <ReadinessContext.Provider value={view.readiness}>
      <View style={styles.page} testID="factory-lean-overview">
        {needsYou.length > 0 ? (
          <Panel title={t("projectFactory.lean.needsYou")} testID="factory-lean-needs-you">
            <SettingsCard>
              {needsYou.map((item) => (
                <NeedsYouRow
                  key={item.key}
                  item={item}
                  serverId={serverId}
                  leadAgentId={leadAgentId}
                  source={source}
                  onPromote={promoteNewest}
                />
              ))}
            </SettingsCard>
          </Panel>
        ) : null}
        <Panel title={t("projectFactory.lean.production")} testID="factory-lean-production">
          <SettingsCard>
            {productionRow ? (
              <ReleaseRow row={productionRow} onAct={setConfirming} />
            ) : (
              <SettingsRow label={t("projectFactory.lean.noProduction")} />
            )}
          </SettingsCard>
        </Panel>
        <Panel title={t("projectFactory.lean.betas")} testID="factory-lean-betas">
          <SettingsCard>
            {releases && releases.betas.length > 0 ? (
              releases.betas.map((row) => (
                <ReleaseRow key={row.event.id} row={row} onAct={setConfirming} />
              ))
            ) : (
              <SettingsRow label={t("projectFactory.lean.noBetas")} />
            )}
          </SettingsCard>
        </Panel>
        {releases && releases.earlier.length > 0 ? (
          <Panel title={t("projectFactory.lean.earlier")} testID="factory-lean-earlier">
            <SettingsCard>
              {releases.earlier.map((row) => (
                <ReleaseRow key={row.event.id} row={row} onAct={setConfirming} />
              ))}
            </SettingsCard>
          </Panel>
        ) : null}
        {view.previews.length > 0 ? (
          <Panel title={t("projectFactory.lean.previews")} testID="factory-lean-previews">
            <SettingsCard>
              {view.previews.map((preview) => (
                <SettingsRow key={preview.workspaceId} label={preview.title} hint={preview.state}>
                  {preview.url ? (
                    <OpenUrlButton url={preview.url} label={t("projectFactory.lean.open")} />
                  ) : null}
                </SettingsRow>
              ))}
            </SettingsCard>
          </Panel>
        ) : null}
        <Panel title={t("projectFactory.lean.activity")} testID="factory-lean-activity">
          <SettingsCard>
            {activity.length > 0 ? (
              activity.slice(0, 20).map((entry) => <ActivityRow key={entry.id} entry={entry} />)
            ) : (
              <SettingsRow label={t("projectFactory.lean.noActivity")} />
            )}
          </SettingsCard>
        </Panel>
        <Panel title={t("projectFactory.lean.health")} testID="factory-lean-health">
          <SettingsCard>
            {alerts.length > 0 ? (
              alerts.map((alert) => <SettingsRow key={alert} label={alert} />)
            ) : (
              <SettingsRow label={t("projectFactory.lean.healthy")} />
            )}
            {view.machines.map((machine) => (
              <SettingsRow
                key={machine.installation}
                label={leanMachineName(machine.installation, view.machines) ?? machine.installation}
                hint={t("projectFactory.lean.machine", {
                  freshness: machine.freshness,
                  open: machine.runnersOpen,
                  max: machine.runnersMax,
                })}
              />
            ))}
            {view.health.deliveryLock ? <DeliveryLockRow view={view} /> : null}
          </SettingsCard>
        </Panel>
        <ReleaseConfirm
          action={confirming}
          source={source}
          serverId={serverId}
          projectId={projectId}
          onClose={closeConfirm}
        />
      </View>
    </ReadinessContext.Provider>
  );
}

/** Opens a link from a row; one memoized handler per button. */
function OpenUrlButton({
  url,
  label,
  variant = "outline",
  disabled = false,
}: {
  url: string;
  label: string;
  variant?: "default" | "outline" | "ghost";
  disabled?: boolean;
}) {
  const open = useCallback(() => void openExternalUrl(url), [url]);
  return (
    <Button size="sm" variant={variant} onPress={open} disabled={disabled}>
      {label}
    </Button>
  );
}

function useAgo(at: string): string {
  const date = useMemo(() => new Date(at), [at]);
  return useTimeAgo(date);
}

function ReleaseRow({
  row,
  onAct,
}: {
  row: LeanReleaseRow;
  onAct: (action: LeanReleaseAction) => void;
}) {
  const { t } = useTranslation();
  const { event, action } = row;
  const ago = useAgo(event.at);
  const blocked = useLeanBlockReason(action?.kind);
  const act = useCallback(() => {
    if (action) onAct(action);
  }, [action, onAct]);
  const parts = [t(`projectFactory.lean.kinds.${event.kind}`, { defaultValue: event.kind }), ago];
  if (event.contents.length > 0) {
    parts.push(t("projectFactory.lean.changes", { count: event.contents.length }));
  }
  if (blocked) parts.push(blocked);
  return (
    <SettingsRow
      label={event.version}
      hint={parts.join(" · ")}
      testID={`factory-lean-release-${event.id}`}
    >
      {action ? (
        <Button
          size="sm"
          variant={action.kind === "promote" ? "default" : "outline"}
          onPress={act}
          disabled={blocked !== null}
          testID={`factory-lean-${action.kind}-${event.id}`}
        >
          {action.kind === "promote"
            ? t("projectFactory.lean.promote")
            : t("projectFactory.lean.rollback")}
        </Button>
      ) : null}
    </SettingsRow>
  );
}

function ActivityRow({ entry }: { entry: LeanActivityEntry }) {
  const { t } = useTranslation();
  const ago = useAgo(entry.at);
  return (
    <SettingsRow label={entry.text} hint={entry.issue ? `#${entry.issue} · ${ago}` : ago}>
      {entry.url ? (
        <OpenUrlButton url={entry.url} label={t("projectFactory.lean.open")} variant="ghost" />
      ) : null}
    </SettingsRow>
  );
}

function DeliveryLockRow({ view }: { view: LeanView }) {
  const { t } = useTranslation();
  const lock = view.health.deliveryLock!;
  const machine = leanMachineName(lock.holder.installationId ?? null, view.machines);
  return (
    <SettingsRow
      label={t("projectFactory.lean.delivering", { batch: lock.batch })}
      hint={machine ?? undefined}
    />
  );
}

function AnswerButton({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const open = useCallback(() => navigateToAgent({ serverId, agentId }), [serverId, agentId]);
  return (
    <Button size="sm" onPress={open}>
      {t("projectFactory.lean.answer")}
    </Button>
  );
}

function NeedsYouRow({
  item,
  serverId,
  leadAgentId,
  source,
  onPromote,
}: {
  item: LeanNeedsYouItem;
  serverId: string;
  leadAgentId: string | null;
  source: LeanSource | null;
  onPromote: () => void;
}) {
  const { t } = useTranslation();
  const blocked = useLeanBlockReason(NEEDS_YOU_ACTION[item.kind]);
  if (item.kind === "beta-notice") return <BetaNoticeRow item={item} source={source} />;
  if (item.kind === "approval") {
    return (
      <SettingsRow
        label={t("projectFactory.lean.approval")}
        hint={[item.version, blocked].filter(Boolean).join(" · ") || undefined}
      >
        {item.url ? (
          <OpenUrlButton
            url={item.url}
            label={t("projectFactory.lean.review")}
            variant="default"
            disabled={blocked !== null}
          />
        ) : null}
      </SettingsRow>
    );
  }
  if (item.kind === "question") {
    return (
      <SettingsRow
        label={item.question}
        hint={
          item.blocksIssues.length > 0
            ? t("projectFactory.lean.blocks", {
                issues: item.blocksIssues.map((issue) => `#${issue}`).join(", "),
              })
            : undefined
        }
      >
        {leadAgentId ? <AnswerButton serverId={serverId} agentId={leadAgentId} /> : null}
      </SettingsRow>
    );
  }
  return (
    <SettingsRow
      label={t("projectFactory.lean.promoteQuestion", { version: item.version })}
      hint={
        [
          item.count > 1 ? t("projectFactory.lean.betasWaiting", { count: item.count }) : null,
          blocked,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
    >
      <Button size="sm" onPress={onPromote} disabled={blocked !== null}>
        {t("projectFactory.lean.promote")}
      </Button>
    </SettingsRow>
  );
}

function BetaNoticeRow({
  item,
  source,
}: {
  item: Extract<LeanNeedsYouItem, { kind: "beta-notice" }>;
  source: LeanSource | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const toggle = useCallback(async () => {
    if (!source) return;
    setPending(true);
    try {
      const result = item.held
        ? await source.releaseBeta(item.eventId)
        : await source.holdBeta(item.eventId);
      if (isRefusal(result)) {
        toast.show(t("projectFactory.lean.refused", { reason: result.refused }), {
          variant: "error",
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["factoryLeanView"] });
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setPending(false);
    }
  }, [item.eventId, item.held, queryClient, source, t, toast]);
  const press = useCallback(() => void toggle(), [toggle]);
  const blocked = useLeanBlockReason("hold");
  const time = useMemo(
    () => new Date(item.shipsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    [item.shipsAt],
  );
  return (
    <SettingsRow
      label={
        item.held
          ? t("projectFactory.lean.betaHeld", { version: item.version })
          : t("projectFactory.lean.betaShips", { version: item.version, time })
      }
      hint={[t("projectFactory.lean.betaResets"), blocked].filter(Boolean).join(" ")}
    >
      <Button
        size="sm"
        variant={item.held ? "default" : "outline"}
        onPress={press}
        disabled={pending || !source || blocked !== null}
        testID="factory-lean-beta-hold"
      >
        {item.held ? t("projectFactory.lean.letShip") : t("projectFactory.lean.hold")}
      </Button>
    </SettingsRow>
  );
}

/**
 * Confirms one exact release action in the app's dialog, showing the version it acts on. A
 * refusal, such as production having moved since the page was read, stays in the dialog.
 */
function ReleaseConfirm({
  action,
  source,
  serverId,
  projectId,
  onClose,
}: {
  action: LeanReleaseAction | null;
  source: LeanSource | null;
  serverId: string;
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => {
    if (pending) return;
    setError(null);
    onClose();
  }, [onClose, pending]);
  const confirm = useCallback(async () => {
    if (!action || !source) return;
    setPending(true);
    setError(null);
    try {
      const result =
        action.kind === "promote"
          ? await source.promote(action.eventId, action.expectedProduction)
          : await source.rollback(action.targetEventId, action.expectedProduction);
      if (isRefusal(result)) {
        setError(t("projectFactory.lean.refused", { reason: result.refused }));
        return;
      }
      toast.show(
        t(
          action.kind === "promote"
            ? "projectFactory.lean.promoteQueued"
            : "projectFactory.lean.rollbackQueued",
          { version: action.version },
        ),
        { variant: "success" },
      );
      await queryClient.invalidateQueries({ queryKey: leanQueryKeys.view(serverId, projectId) });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }, [action, onClose, projectId, queryClient, serverId, source, t, toast]);
  const pressConfirm = useCallback(() => void confirm(), [confirm]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: action
        ? t(
            action.kind === "promote"
              ? "projectFactory.lean.promoteTitle"
              : "projectFactory.lean.rollbackTitle",
            { version: action.version },
          )
        : "",
    }),
    [action, t],
  );
  const footer = useMemo(
    () => (
      <ActionFooter style={styles.actions}>
        <Button variant="secondary" size="sm" onPress={close} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant={action?.kind === "rollback" ? "destructive" : "default"}
          size="sm"
          onPress={pressConfirm}
          disabled={pending || !source}
          testID="factory-lean-release-confirm"
        >
          {action?.kind === "rollback"
            ? t("projectFactory.lean.rollbackTo", { version: action.version })
            : t("projectFactory.lean.promoteVersion", { version: action?.version ?? "" })}
        </Button>
      </ActionFooter>
    ),
    [action, close, pending, pressConfirm, source, t],
  );
  return (
    <AdaptiveModalSheet
      visible={action !== null}
      onClose={close}
      header={header}
      footer={footer}
      testID="factory-lean-release-dialog"
    >
      <View style={styles.dialogBody}>
        <Text style={styles.body}>
          {action?.kind === "rollback"
            ? t("projectFactory.lean.rollbackBody", { version: action.version })
            : t("projectFactory.lean.promoteBody", { version: action?.version ?? "" })}
        </Text>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { gap: theme.spacing[4] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  dialogBody: { gap: theme.spacing[3], paddingBottom: theme.spacing[2] },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));
