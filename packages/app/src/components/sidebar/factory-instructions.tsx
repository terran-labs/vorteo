import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { StyleSheet } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { FactoryModelControls } from "./factory-model-controls";
import { useFetchQuery } from "@/data/query";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { create } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useInstalledPlugins } from "@/plugins/registry";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ActionFooter } from "@/components/ui/action-footer";
import {
  type Instructions,
  type RoleId,
  instructionDiff,
  openFactoryInstructionsForm,
} from "./factory-instructions-model";
import type { ProjectFactoryState } from "./project-factory";
interface Target {
  serverId: string;
  projectId: string;
  role?: RoleId;
  modelsOnly?: boolean;
  openId?: number;
}
const panel = create<{ target: Target | null }>(() => ({ target: null }));
let nextOpenId = 0;
export const openFactoryInstructions = (target: Target) =>
  panel.setState({ target: { ...target, openId: ++nextOpenId } });
export function useProjectFactory(serverId: string, projectId: string, enabled: boolean) {
  const active = useRetainedPanelActive();
  const plugin = useInstalledPlugins().find((p) => p.id === "factory" && p.serverId === serverId);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: ["projectFactory", serverId, projectId],
    enabled: enabled && active && !!plugin && !!projectId,
    refetchInterval: active ? 60_000 : false,
    queryFn: async () =>
      (await plugin!.invoke("factory.project.get", {
        projectId,
      })) as ProjectFactoryState,
  });
}
export function FactoryInstructionsPanel() {
  const target = panel((s) => s.target);
  return target ? <Panel key={target.openId} target={target} /> : null;
}
function Panel({ target }: { target: Target }) {
  const { t } = useTranslation();
  const plugin = useInstalledPlugins().find(
    (p) => p.id === "factory" && p.serverId === target.serverId,
  );
  const [role, setRole] = useState<RoleId>(target.role ?? "factory-triage");
  const query = useFetchQuery({
    gcTime: 0,
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: ["factoryInstructions", target.serverId, target.projectId, role, target.openId],
    queryFn: async () =>
      (await plugin!.invoke("factory.project.instructions.get", {
        projectId: target.projectId,
        role,
      })) as Instructions,
    enabled: !!plugin && !target.modelsOnly,
  });
  const roles = useMemo(
    () =>
      !target.role ? (
        <View>
          {(
            [
              "factory-triage",
              "factory-intake",
              "factory-builds",
              "factory-releases",
              "factory-mechanic",
            ] as RoleId[]
          ).map((id, i) => (
            <RoleButton
              key={id}
              role={id}
              label={["Triage", "Foreman", "Builds", "Releases", "Mechanic"][i]}
              onSelect={setRole}
            />
          ))}
        </View>
      ) : null,
    [target.role],
  );
  const close = useCallback(() => panel.setState({ target: null }), []);
  const header = useMemo(() => ({ title: t("projectFactory.instructions") }), [t]);
  if (target.modelsOnly)
    return (
      <AdaptiveModalSheet visible onClose={close} header={header}>
        <FactoryModelControls serverId={target.serverId} projectId={target.projectId} />
      </AdaptiveModalSheet>
    );
  if (query.data && plugin)
    return (
      <Editor
        key={role}
        target={target}
        initial={query.data}
        invoke={plugin.invoke}
        roles={roles}
      />
    );
  return (
    <AdaptiveModalSheet visible onClose={close} header={header}>
      {roles}
      <Text style={textStyles.text}>{query.error?.message ?? t("projectFactory.loading")}</Text>
    </AdaptiveModalSheet>
  );
}

function Editor({
  target,
  initial,
  invoke,
  roles,
}: {
  roles: import("react").ReactNode;
  target: Target;
  initial: Instructions;
  invoke: (method: string, input: unknown) => Promise<unknown>;
}) {
  const compact = useIsCompactFormFactor();
  const { t } = useTranslation();
  const client = useQueryClient();
  const [model] = useState(() =>
    openFactoryInstructionsForm({
      initial,
      projectId: target.projectId,
      invoke,
      onSaved: () => {
        void client.invalidateQueries({
          queryKey: ["projectFactory", target.serverId, target.projectId],
        });
      },
    }),
  );
  const snapshot = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { instructions: state, draft, pending } = snapshot;
  const error = snapshot.error ? `${t("projectFactory.saveFailed")} ${snapshot.error}` : null;
  const [charterOpen, setCharterOpen] = useState(false);
  const [history, setHistory] = useState<number | null>(null);
  const proposal = state.review.status === "proposed" ? state.review.proposal : null;
  const close = useCallback(() => {
    if (!pending) panel.setState({ target: null });
  }, [pending]);
  const header = useMemo(() => ({ title: t("projectFactory.instructions") }), [t]);
  const save = useCallback(() => void model.write({ additions: draft }), [model, draft]);
  const accept = useCallback(() => void model.write({ accept: true }), [model]);
  const dismiss = useCallback(() => void model.write({ accept: false }), [model]);
  const toggleCharter = useCallback(() => setCharterOpen((value) => !value), []);
  const footer = useMemo(
    () => (
      <ActionFooter>
        {proposal ? (
          <>
            <Button disabled={pending} onPress={dismiss}>
              {t("projectFactory.dismiss")}
            </Button>
            <Button disabled={pending} onPress={accept}>
              {t("projectFactory.accept")}
            </Button>
          </>
        ) : null}
        <Button disabled={pending || draft === state.additions} onPress={save}>
          {t("common.actions.save")}
        </Button>
      </ActionFooter>
    ),
    [proposal, pending, dismiss, accept, draft, state.additions, save, t],
  );
  return (
    <AdaptiveModalSheet visible onClose={close} header={header} footer={footer}>
      {roles}
      <FactoryModelControls
        serverId={target.serverId}
        projectId={target.projectId}
        role={state.role}
      />
      <Button variant="secondary" onPress={toggleCharter}>
        {t("projectFactory.shippedCharter")}
      </Button>
      {charterOpen ? (
        <Text style={textStyles.text} selectable>
          {state.shippedCharter}
        </Text>
      ) : null}
      <Text style={textStyles.text}>
        {t("projectFactory.revision", {
          revision: state.revision,
          updatedAt: state.updatedAt ?? t("projectFactory.never"),
        })}
      </Text>
      <Text style={textStyles.text}>{t("projectFactory.projectInstructions")}</Text>
      <FormTextInput
        size={compact ? "md" : "sm"}
        key={state.revision}
        initialValue={draft}
        onChangeText={model.setDraft}
        multiline
        numberOfLines={8}
        editable={!pending}
        accessibilityLabel={t("projectFactory.projectInstructions")}
      />

      {error ? (
        <Text style={textStyles.text} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {state.review.status !== "none" ? (
        <>
          <Text style={textStyles.text}>
            {t(
              state.review.status === "proposed"
                ? "projectFactory.reviewProposed"
                : "projectFactory.reviewNeeded",
            )}
          </Text>
          <Diff before={state.basedOn?.charterText ?? ""} after={state.shippedCharter} />
        </>
      ) : null}
      {proposal ? (
        <>
          <Text style={textStyles.text} selectable>
            {proposal.rationale}
          </Text>
          <Text style={textStyles.text} selectable>
            {proposal.text}
          </Text>
          <Diff before={state.additions} after={proposal.text} />
        </>
      ) : null}
      <Text style={textStyles.text}>{t("projectFactory.history")}</Text>
      {state.history.map((item) => (
        <HistoryItem
          key={item.revision}
          item={item}
          expanded={history === item.revision}
          onSelect={setHistory}
        />
      ))}
    </AdaptiveModalSheet>
  );
}
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <View>
      {instructionDiff(before, after).map((line, i) => (
        <Text style={textStyles.text} selectable key={`${line.kind}:${line.text}:${i.toString()}`}>
          {line.kind === "added" ? "+ " : "− "}
          {line.text}
        </Text>
      ))}
    </View>
  );
}

function RoleButton({
  role,
  label,
  onSelect,
}: {
  role: RoleId;
  label: string;
  onSelect: (role: RoleId) => void;
}) {
  const select = useCallback(() => onSelect(role), [onSelect, role]);
  return <Button onPress={select}>{label}</Button>;
}
function HistoryItem({
  item,
  expanded,
  onSelect,
}: {
  item: Instructions["history"][number];
  expanded: boolean;
  onSelect: (revision: number | null) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(
    () => onSelect(expanded ? null : item.revision),
    [onSelect, expanded, item.revision],
  );
  return (
    <View>
      <Button variant="secondary" onPress={select}>
        {t("projectFactory.revision", { revision: item.revision, updatedAt: item.updatedAt })}
      </Button>
      {expanded ? (
        <Text style={textStyles.text} selectable>
          {item.additions}
        </Text>
      ) : null}
    </View>
  );
}

const textStyles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
