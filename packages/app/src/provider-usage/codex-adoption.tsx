import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { InstallationRequestFailed } from "@/execution-installation/client";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { Button } from "@/components/ui/button";
import { ActionFooter, ActionFooterLeading } from "@/components/ui/action-footer";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isWeb } from "@/constants/platform";
import {
  codexAdoptionRead,
  codexAdoptionRequest,
  type CodexAdoption,
} from "./codex-installation-login";
import { useOwnerAllowed } from "./use-provider-login";

/** States the coordinator moves through by itself; the control polls while one lasts. */
const MOVING = new Set(["verifying-host", "pinning", "projecting", "unadopting"]);
/** States an un-adopt can end: a projection may be delivered, or the record awaits the owner. */
const UNADOPTABLE = new Set([
  "projecting",
  "adopted",
  "failed",
  "cancelled",
  "needs-owner-confirmation",
]);

/**
 * The legacy Codex account bound to this provider, and whether the coordinator can adopt it.
 * Null when the account is not legacy or the coordinator has no adoption routes.
 */
export function useCodexAdoption(serverId: string | null, providerId: string) {
  const ownerAllowed = useOwnerAllowed(serverId);
  const installation = readExecutionInstallation();
  const inInstallation = Boolean(
    installation?.environments.some((environment) => environment.serverId === serverId),
  );
  const query = useFetchQuery({
    queryKey: ["codex-adoption", installation?.installationId, serverId, providerId],
    queryFn: () => codexAdoptionRead(serverId!, providerId),
    enabled: ownerAllowed && inInstallation && Boolean(serverId && providerId),
    refetchInterval: (current) =>
      MOVING.has(current.state.data?.adoption?.status ?? "") ? 2000 : false,
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: false,
  });
  return query;
}

/** Whether a Codex account row should offer its connection dialog for adoption. */
export function useCodexAdoptionOffered(serverId: string | null, providerId: string): boolean {
  return Boolean(useCodexAdoption(serverId, providerId).data);
}

type Translate = ReturnType<typeof useTranslation>["t"];

function adoptionStatus(
  t: Translate,
  entry: { eligible: boolean; reason: string | null; adoption: CodexAdoption | null },
): string | null {
  const adoption = entry.adoption;
  const reason = adoption?.error ?? "";
  switch (adoption?.status) {
    case undefined:
      return null;
    case "verifying-host":
    case "pinning":
      return t("codexAdoption.status.inProgress");
    case "projecting":
      return t("codexAdoption.status.pending");
    case "adopted":
      return t("codexAdoption.status.adopted");
    case "failed":
      return reason
        ? t("codexAdoption.status.failed", { reason })
        : t("codexAdoption.status.failedUnknown");
    case "needs-owner-confirmation":
      return t("codexAdoption.status.needsConfirmation", { reason });
    case "cancelled":
      return t("codexAdoption.status.cancelled");
    case "unadopting":
      return t("codexAdoption.status.unadopting");
    case "unadopted": {
      let detail = t("codexAdoption.status.signedOut");
      if (adoption.restoreSkipped) detail = t("codexAdoption.status.restoreSkipped");
      else if (adoption.restored) detail = t("codexAdoption.status.restored");
      return `${t("codexAdoption.status.unadopted")} ${detail}`;
    }
    default:
      // A state from a newer coordinator: it is still working on the account.
      return t("codexAdoption.status.inProgress");
  }
}

function adoptLabel(t: Translate, status: string | undefined): string | null {
  if (status === undefined || status === "unadopted") return t("codexAdoption.actions.adopt");
  if (status === "failed" || status === "cancelled") return t("codexAdoption.actions.retry");
  if (status === "needs-owner-confirmation") return t("codexAdoption.actions.confirm");
  return null;
}

/** What the section shows for an entry, an action's notice and whether an action runs. */
function sectionModel(
  t: Translate,
  entry: { eligible: boolean; reason: string | null; adoption: CodexAdoption | null },
  notice: string | null,
  pending: boolean,
) {
  const status = entry.adoption?.status;
  return {
    busy: pending || MOVING.has(status ?? ""),
    // A failed record already states the coordinator's reason.
    text: (status !== "failed" ? notice : null) ?? adoptionStatus(t, entry),
    adoptText: entry.eligible ? adoptLabel(t, status) : null,
    canUnadopt: UNADOPTABLE.has(status ?? ""),
    // Un-adopt stays available while Dev has not yet confirmed a projection.
    unadoptDisabled: pending || status === "unadopting",
    unavailable: !entry.eligible && (status === undefined || status === "unadopted"),
  };
}

/**
 * Adopting a legacy Codex account: Dev keeps its connection, home and history and receives the
 * Host's sign-in. Shown only for a legacy account on a coordinator with the adoption routes.
 */
export function CodexAdoptionSection({
  serverId,
  providerId,
}: {
  serverId: string | null;
  providerId: string;
}) {
  const { t } = useTranslation();
  const query = useCodexAdoption(serverId, providerId);
  const cache = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const entry = query.data ?? null;
  const status = entry?.adoption?.status;
  // Whether the panel signs in through the Host follows the adoption's state.
  useEffect(() => {
    void cache.invalidateQueries({ queryKey: ["codex-installation-account"] });
  }, [cache, status]);
  const action = useMutation({
    gcTime: 0,
    mutationFn: (operation: "adopt" | "unadopt") =>
      codexAdoptionRequest(entry!.definitionId, operation),
    onMutate: () => setNotice(null),
    onError: (error) =>
      setNotice(
        error instanceof InstallationRequestFailed && error.status === 409
          ? error.message
          : t("codexAdoption.status.requestFailed"),
      ),
    onSettled: () => void query.refetch(),
  });
  const { mutate } = action;
  // Every switch replaces a working Dev sign-in, so it asks first, as un-adopt does.
  const adopt = useCallback(async () => {
    const opener =
      isWeb && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const confirmed = await confirmDialog({
      title: t("codexAdoption.adoptConfirm.title"),
      message: t("codexAdoption.adoptConfirm.message"),
      confirmLabel: t("codexAdoption.adoptConfirm.confirm"),
    });
    if (opener?.isConnected) opener.focus();
    if (confirmed) mutate("adopt");
  }, [mutate, t]);
  const unadopt = useCallback(async () => {
    const opener =
      isWeb && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const confirmed = await confirmDialog({
      title: t("codexAdoption.unadoptConfirm.title"),
      message: t("codexAdoption.unadoptConfirm.message"),
      confirmLabel: t("codexAdoption.unadoptConfirm.confirm"),
    });
    if (opener?.isConnected) opener.focus();
    if (confirmed) mutate("unadopt");
  }, [mutate, t]);

  if (query.isLoading) return <Text style={styles.muted}>{t("codexAdoption.checking")}</Text>;
  if (!entry) return null;
  const { busy, text, adoptText, canUnadopt, unadoptDisabled, unavailable } = sectionModel(
    t,
    entry,
    notice,
    action.isPending,
  );
  return (
    <View style={styles.section} testID="codex-adoption">
      <Text style={styles.title}>{t("codexAdoption.title")}</Text>
      {text ? (
        <View role="status" aria-live="polite" accessibilityLiveRegion="polite">
          <Text style={styles.text}>{text}</Text>
        </View>
      ) : null}
      {unavailable ? (
        <Text style={styles.muted}>
          {t("codexAdoption.unavailable", { reason: entry.reason ?? "" })}
        </Text>
      ) : null}
      {adoptText && !busy ? (
        <Text style={styles.muted}>{t("codexAdoption.description")}</Text>
      ) : null}
      {canUnadopt ? <Text style={styles.muted}>{t("codexAdoption.unadoptNote")}</Text> : null}
      {entry.adoption?.copyDeleteBlocked ? (
        <Text style={styles.text}>
          {t("codexAdoption.copyDeleteBlocked", { reason: entry.adoption.copyDeleteBlocked })}
        </Text>
      ) : null}
      {adoptText || canUnadopt ? (
        <ActionFooter style={styles.actions}>
          {canUnadopt ? (
            <ActionFooterLeading>
              <Button
                variant="outline"
                onPress={unadopt}
                disabled={unadoptDisabled}
                focusableWhenDisabled
                testID="codex-adoption-unadopt"
              >
                {t("codexAdoption.actions.unadopt")}
              </Button>
            </ActionFooterLeading>
          ) : null}
          {adoptText ? (
            <Button
              variant="outline"
              onPress={adopt}
              disabled={busy}
              focusableWhenDisabled
              testID="codex-adoption-adopt"
            >
              {adoptText}
            </Button>
          ) : null}
        </ActionFooter>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: { paddingTop: 0 },
}));
