import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsCollapsibleRow, SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { openFactoryInstructions } from "@/components/sidebar/factory-instructions";
import { FactoryModelControls } from "@/components/sidebar/factory-model-controls";
import { freshFactoryStatus } from "@/components/sidebar/project-factory-model";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { factoryRoleAssignments } from "./queue";

export interface FactoryControls {
  pause: () => void;
  resume: () => void;
  setPlanning: (value: boolean) => void;
  pending: boolean;
  error: Error | null;
}

export interface ControlTarget {
  serverId: string;
  projectId: string;
  state: ProjectFactoryState;
  controls: FactoryControls;
}

function stateVariant(state: ProjectFactoryState): StatusBadgeVariant {
  if (state.drain) return "warning";
  switch (state.state) {
    case "on":
      return "success";
    case "paused":
      return "warning";
    case "unavailable":
      return "error";
    default:
      return "muted";
  }
}

/** State pill, Pause or Resume, and the Planning switch: the controls used most. */
export function FactoryRunControls({ state, controls }: ControlTarget) {
  const { t } = useTranslation();
  const label = state.drain
    ? t("projectFactory.draining", { reason: state.drain.reason })
    : t(`projectFactory.states.${state.state}`);
  return (
    <View style={styles.run}>
      <StatusBadge label={label} variant={stateVariant(state)} />
      {state.state === "on" ? (
        <Button onPress={controls.pause} disabled={controls.pending}>
          {t("projectFactory.pauseMenu")}
        </Button>
      ) : null}
      {state.state === "paused" ? (
        <Button onPress={controls.resume} disabled={controls.pending}>
          {t("projectFactory.resumeMenu")}
        </Button>
      ) : null}
      {state.workers.planning !== undefined ? (
        <View style={styles.switchGroup}>
          <Text style={styles.text}>{t("projectFactory.planning")}</Text>
          <Switch
            value={state.workers.planning}
            onValueChange={controls.setPlanning}
            disabled={controls.pending}
            accessibilityLabel={t("projectFactory.planning")}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Drain time, unavailable reason, saving and mutation errors. Renders nothing when quiet. */
export function FactoryControlNotes({ state, controls }: ControlTarget) {
  const { t } = useTranslation();
  if (!state.drain && !state.reason && !controls.pending && !controls.error) return null;
  return (
    <View style={styles.notes}>
      {state.drain ? (
        <Text style={styles.text}>
          {t("projectFactory.pausedAt", { time: new Date(state.drain.pausedAt).toLocaleString() })}
        </Text>
      ) : null}
      {state.reason ? <Text style={styles.text}>{state.reason}</Text> : null}
      {controls.pending ? <Text style={styles.text}>{t("projectFactory.saving")}</Text> : null}
      {controls.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {controls.error.message}
        </Text>
      ) : null}
    </View>
  );
}

/** Stage models, every role and role assignment, folded into one card of collapsible rows. */
export function FactoryModelsAndRoles({ serverId, projectId, state }: ControlTarget) {
  const { t } = useTranslation();
  const assignments = factoryRoleAssignments(state);
  return (
    <SettingsCard testID="factory-models-and-roles">
      <SettingsCollapsibleRow
        label={t("projectFactory.issueStages")}
        summary={t("projectFactory.controls.stageSummary")}
      >
        <View style={styles.nested}>
          <Text style={styles.hint}>{t("projectFactory.nextIssue")}</Text>
          <FactoryModelControls serverId={serverId} projectId={projectId} stages />
        </View>
      </SettingsCollapsibleRow>
      {state.roles.map((role) => (
        <RoleRow key={role.role} serverId={serverId} projectId={projectId} role={role} />
      ))}
      {assignments ? (
        <SettingsCollapsibleRow
          label={t("projectFactory.assignment.title")}
          summary={assignmentSummary(assignments, t)}
        >
          {state.installation ? (
            <SettingsRow
              label={t("projectFactory.assignment.installation", {
                installation: state.installation,
              })}
            />
          ) : null}
          {assignments.map(({ role, runner, offHere, detail }) => (
            <SettingsRow
              key={role}
              label={`${t(`projectFactory.assignment.roles.${role}`)}: ${
                runner.kind === "other"
                  ? runner.installation
                  : t(`projectFactory.assignment.runners.${runner.kind}`)
              }`}
              hint={offHereHint(offHere, detail, t)}
            />
          ))}
        </SettingsCollapsibleRow>
      ) : null}
    </SettingsCard>
  );
}

function offHereHint(
  offHere: boolean,
  detail: string | null,
  t: (key: string, options?: Record<string, string>) => string,
): string | undefined {
  if (!offHere) return undefined;
  return detail
    ? t("projectFactory.assignment.offHereDetail", { detail })
    : t("projectFactory.assignment.offHere");
}

function assignmentSummary(
  assignments: NonNullable<ReturnType<typeof factoryRoleAssignments>>,
  t: (key: string) => string,
): string {
  const off = assignments.filter((entry) => entry.offHere).length;
  return off ? t("projectFactory.assignment.offHere") : t("projectFactory.assignment.runners.here");
}

function RoleRow({
  serverId,
  projectId,
  role,
}: {
  serverId: string;
  projectId: string;
  role: ProjectFactoryState["roles"][number];
}) {
  const { t } = useTranslation();
  const instructions = useCallback(
    () => openFactoryInstructions({ serverId, projectId, role: role.role }),
    [serverId, projectId, role.role],
  );
  const openThread = useCallback(() => {
    if (role.agentId) navigateToAgent({ serverId, agentId: role.agentId });
  }, [serverId, role.agentId]);
  const status = freshFactoryStatus(role.status) ? role.status!.line : undefined;
  return (
    <SettingsCollapsibleRow
      label={role.title}
      summary={status ?? t("projectFactory.controls.noStatus")}
      testID={`factory-role-${role.role}`}
    >
      <SettingsRow label={t("projectFactory.controls.thread")} hint={status}>
        <View style={styles.buttons}>
          {role.agentId ? (
            <Button onPress={openThread}>{t("projectFactory.openThread")}</Button>
          ) : null}
          <Button onPress={instructions}>{t("projectFactory.instructions")}</Button>
        </View>
      </SettingsRow>
      <View style={styles.nested}>
        <FactoryModelControls serverId={serverId} projectId={projectId} role={role.role} />
      </View>
    </SettingsCollapsibleRow>
  );
}

/** One line of controls with the rest behind a "Models & roles" disclosure. */
export function FactoryControlStrip(target: ControlTarget) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <View style={styles.strip} testID="factory-control-strip">
      <View style={styles.stripRow}>
        <FactoryRunControls {...target} />
        <Button
          variant="ghost"
          onPress={toggle}
          leftIcon={open ? ChevronDown : ChevronRight}
          accessibilityState={open ? EXPANDED : COLLAPSED}
          testID="factory-models-and-roles-toggle"
        >
          {t("projectFactory.controls.modelsAndRoles")}
        </Button>
      </View>
      <FactoryControlNotes {...target} />
      {open ? <FactoryModelsAndRoles {...target} /> : null}
    </View>
  );
}

const EXPANDED = { expanded: true };
const COLLAPSED = { expanded: false };

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  run: {
    flexShrink: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  switchGroup: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  notes: { gap: theme.spacing[1] },
  nested: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  strip: { gap: theme.spacing[3] },
  stripRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
}));
