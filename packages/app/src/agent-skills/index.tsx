import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/components/settings";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router/react-navigation";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowUpRight, Blocks, Check, Settings2 } from "lucide-react-native";
import type { AgentSkillOperation, AgentSkillsStatus } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { toErrorMessage } from "@/utils/error-messages";
import { SkillSelectionSheet } from "./selection-sheet";
import { useAgentSkills, type AgentSkillsController } from "./use-agent-skills";
import { OwnerSettingsGate } from "@/components/settings/owner-lock";
export { useAgentSkills, type AgentSkillsController } from "./use-agent-skills";

const OP_KIND_ORDER: Record<AgentSkillOperation["kind"], number> = {
  add: 0,
  update: 1,
  delete: 2,
};
const ThemedBlocks = withUnistyles(Blocks);
const ThemedCheck = withUnistyles(Check);
const ThemedSettings = withUnistyles(Settings2);
const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const SKILLS_DOCS_URL = "https://paseo.sh/docs/skills";
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function formatUpdateMessage(ops: readonly AgentSkillOperation[], t: TFunction): string {
  return [...ops]
    .sort((a, b) => OP_KIND_ORDER[a.kind] - OP_KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
    .map((op) => `${t(`settings.host.skills.operations.${op.kind}`)} ${op.name}`)
    .join("\n");
}

function skillDisplayState({
  status,
  managed,
}: {
  status: AgentSkillsStatus | null;
  managed: boolean;
}): AgentSkillsStatus["state"] | null {
  if (!status) return null;
  if (managed) return status.state;
  if (status.state === "drift" && status.ops.every((op) => op.kind === "delete"))
    return "up-to-date";
  return status.state;
}

/** Whether the host has Paseo's skills installed in any form, current or not. */
export function areSkillsInstalled(status: AgentSkillsStatus | null): boolean {
  return status !== null && status.state !== "not-installed";
}

/** Whether the saved selection names any skill there is to install. */
export function hasSelectedSkills(status: AgentSkillsStatus | null): boolean {
  if (!status) return false;
  if (status.selection.mode === "all") return status.available.length > 0;
  return status.selection.skills.some((name) => status.available.includes(name));
}

export function AgentSkillsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const skills = useAgentSkills(serverId);
  const refreshSkills = skills.refresh;
  const skillsConnected = skills.connected;
  const skillsSupported = skills.supported;
  const [isChoosing, setIsChoosing] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (skillsConnected && skillsSupported) void refreshSkills();
      return undefined;
    }, [refreshSkills, skillsConnected, skillsSupported]),
  );
  const maintenanceOps = useMemo(
    () => skills.status?.ops.filter((op) => op.kind !== "delete") ?? [],
    [skills.status?.ops],
  );
  const state = skillDisplayState({ status: skills.status, managed: skills.managed });
  const hasSelected =
    (skills.status?.selection.mode === "all" && skills.status.available.length > 0) ||
    (skills.status?.selection.mode === "custom" &&
      skills.status.selection.skills.some((name) => skills.status?.available.includes(name)));

  const handleReconcile = useCallback(async () => {
    if (skills.isWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.host.skills.updateTitle"),
      message:
        maintenanceOps.length > 0
          ? formatUpdateMessage(maintenanceOps, t)
          : t("settings.host.skills.updateFallback"),
      confirmLabel: t("settings.host.skills.actions.update"),
    });
    if (confirmed) await skills.reconcile();
  }, [maintenanceOps, skills, t]);
  const handleUninstall = useCallback(async () => {
    if (skills.isWorking) return;
    await skills.uninstall();
  }, [skills]);
  const chooseIcon = useMemo(
    () => <ThemedSettings size={ICON_SIZE.sm} uniProps={mutedMapping} />,
    [],
  );
  const handleOpen = useCallback(() => setIsChoosing(true), []);
  const handleClose = useCallback(() => setIsChoosing(false), []);
  const handleOpenDocs = useCallback(() => {
    void openExternalUrl(SKILLS_DOCS_URL);
  }, []);
  const docsIcon = useMemo(
    () => <ThemedArrowUpRight size={ICON_SIZE.sm} uniProps={mutedMapping} />,
    [],
  );
  const trailing = useMemo(
    () => (
      <Button
        variant="ghost"
        leftIcon={docsIcon}
        style={settingsStyles.sectionHeaderLink}
        onPress={handleOpenDocs}
        accessibilityLabel={t("settings.host.skills.openDocs")}
      >
        {t("settings.host.skills.docs")}
      </Button>
    ),
    [docsIcon, handleOpenDocs, t],
  );

  // Locked shared settings show the same locked card as the other owner settings, not an error.
  if (skills.locked)
    return (
      <OwnerSettingsGate title={t("settings.host.skills.sectionTitle")}>{null}</OwnerSettingsGate>
    );

  if (!skills.connected || !skills.supported) {
    return (
      <SettingsSection title={t("settings.host.skills.sectionTitle")} trailing={trailing}>
        <View style={settingsStyles.card} testID="host-agent-skills-unavailable">
          <View style={styles.emptyCard}>
            <Text style={styles.mutedText}>
              {skills.connected
                ? t("settings.host.skills.unsupported")
                : t("settings.host.skills.unavailable")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t("settings.host.skills.sectionTitle")}
      trailing={trailing}
      status={skills.problem ?? (skills.error ? toErrorMessage(skills.error) : null)}
    >
      <View style={settingsStyles.card} testID="host-agent-skills-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <ThemedBlocks size={ICON_SIZE.md} uniProps={foregroundMapping} />
              <Text style={settingsStyles.rowTitle}>{t("settings.host.skills.title")}</Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              {state === "drift"
                ? t("settings.host.skills.updateAvailable")
                : t("settings.host.skills.description")}
            </Text>
          </View>
          <View style={styles.actionsRow}>
            <Button
              variant="ghost"
              leftIcon={chooseIcon}
              onPress={handleOpen}
              disabled={skills.status === null || skills.isWorking}
              accessibilityLabel={t("settings.host.skills.choose")}
            />
            {hasSelected ? (
              <SkillsActions
                state={state}
                isWorking={skills.isWorking}
                onInstall={skills.reconcile}
                onReconcile={handleReconcile}
                onUninstall={handleUninstall}
              />
            ) : null}
          </View>
        </View>
      </View>
      {skills.status ? (
        <SkillSelectionSheet
          visible={isChoosing}
          available={skills.status.available}
          selection={skills.status.selection}
          isSaving={skills.isWorking}
          onSave={skills.saveSelection}
          onClose={handleClose}
        />
      ) : null}
    </SettingsSection>
  );
}

function SkillsActions({
  state,
  isWorking,
  onReconcile,
  onInstall,
  onUninstall,
}: {
  state: AgentSkillsStatus["state"] | null;
  isWorking: boolean;
  onReconcile: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation();
  if (state === "up-to-date") {
    return (
      <View style={styles.actionsRow}>
        <View style={styles.installedLabel}>
          <ThemedCheck size={14} uniProps={mutedMapping} />
          <Text style={styles.mutedText}>{t("settings.host.skills.actions.installed")}</Text>
        </View>
        <Button variant="outline" onPress={onUninstall} disabled={isWorking}>
          {t("settings.host.skills.actions.uninstall")}
        </Button>
      </View>
    );
  }
  if (state === "drift") {
    return (
      <View style={styles.actionsRow}>
        <Button variant="outline" onPress={onReconcile} disabled={isWorking}>
          {isWorking
            ? t("settings.host.skills.actions.working")
            : t("settings.host.skills.actions.update")}
        </Button>
        <Button variant="outline" onPress={onUninstall} disabled={isWorking}>
          {t("settings.host.skills.actions.uninstall")}
        </Button>
      </View>
    );
  }
  return (
    <Button variant="outline" onPress={onInstall} disabled={isWorking}>
      {isWorking
        ? t("settings.host.skills.actions.installing")
        : t("settings.host.skills.actions.install")}
    </Button>
  );
}

/**
 * The orchestration skills row: a switch for whether they are installed, a gear that opens the
 * skill picker, and Update when the installed skills fall behind the bundled ones. The caller
 * decides what the switch is bound to; the picker and Update always act on the host.
 */
export function AgentSkillsRow({
  skills,
  value,
  onValueChange,
  disabled = false,
}: {
  skills: AgentSkillsController;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { status, isWorking, reconcile, saveSelection } = skills;
  const [isChoosing, setIsChoosing] = useState(false);
  // Deleting a deselected skill is a choice made in the picker, not an update to offer here.
  const maintenanceOps = useMemo(
    () => status?.ops.filter((op) => op.kind !== "delete") ?? [],
    [status?.ops],
  );
  const needsUpdate = status?.state === "drift" && maintenanceOps.length > 0;

  const handleUpdate = useCallback(async () => {
    if (isWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.host.skills.updateTitle"),
      message: formatUpdateMessage(maintenanceOps, t),
      confirmLabel: t("settings.host.skills.actions.update"),
    });
    if (confirmed) await reconcile();
  }, [isWorking, maintenanceOps, reconcile, t]);
  const handleOpen = useCallback(() => setIsChoosing(true), []);
  const handleClose = useCallback(() => setIsChoosing(false), []);
  const chooseIcon = useMemo(
    () => <ThemedSettings size={ICON_SIZE.sm} uniProps={mutedMapping} />,
    [],
  );

  return (
    <>
      <SettingsRow
        label={t("settings.host.skills.title")}
        error={skills.problem}
        hint={
          needsUpdate
            ? t("settings.host.skills.updateAvailable")
            : t("settings.host.skills.description")
        }
      >
        <View style={styles.controls}>
          {needsUpdate ? (
            <Button variant="outline" onPress={handleUpdate} disabled={disabled || isWorking}>
              {isWorking
                ? t("settings.host.skills.actions.working")
                : t("settings.host.skills.actions.update")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            leftIcon={chooseIcon}
            onPress={handleOpen}
            disabled={disabled || status === null || isWorking}
            accessibilityLabel={t("settings.host.skills.choose")}
          />
          <Switch
            value={value}
            onValueChange={onValueChange}
            // Nothing picked means nothing to install; the gear is the way forward.
            disabled={
              disabled || status === null || isWorking || (!value && !hasSelectedSkills(status))
            }
            accessibilityLabel={t("settings.host.skills.title")}
          />
        </View>
      </SettingsRow>
      {status ? (
        <SkillSelectionSheet
          visible={isChoosing}
          available={status.available}
          selection={status.selection}
          isSaving={isWorking}
          onSave={saveSelection}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  installedLabel: { flexDirection: "row", alignItems: "center", gap: 4 },
  mutedText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actionsRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  emptyCard: { padding: theme.spacing[4] },
}));
