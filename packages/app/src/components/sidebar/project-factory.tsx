import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { StyleSheet } from "react-native-unistyles";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ActionFooter } from "@/components/ui/action-footer";
import { Button } from "@/components/ui/button";

export type { ProjectFactoryState } from "./factory-state";
import type { ProjectFactoryState } from "./factory-state";
export {
  validFactoryRepository,
  factoryActions,
  factoryRepositoryFromRemote,
} from "./project-factory-model";
import { validFactoryRepository, factoryRepositoryFromRemote } from "./project-factory-model";
interface Request {
  action: "enable" | "disable";
  repository: string;
  invoke: (method: string, input: unknown) => Promise<unknown>;
  projectId: string;
  onResult: (state: ProjectFactoryState) => void;
}
const dialog = create<{ request: Request | null }>(() => ({ request: null }));
export async function openFactoryDialog(
  request: Omit<Request, "repository"> & {
    serverId: string;
    projectPath: string;
    repository: string | null;
  },
) {
  let repository = request.repository ?? "";
  if (request.action === "enable" && !repository) {
    try {
      const status = await getHostRuntimeStore()
        .getClient(request.serverId)
        ?.getCheckoutStatus(request.projectPath);
      repository = factoryRepositoryFromRemote(status?.remoteUrl);
    } catch {
      /* Manual entry remains available. */
    }
  }
  dialog.setState({ request: { ...request, repository } });
}
export function ProjectFactoryDialog() {
  const request = dialog((s) => s.request);
  return request ? (
    <FactoryDialog key={`${request.projectId}:${request.action}`} request={request} />
  ) : null;
}
function FactoryDialog({ request }: { request: Request }) {
  const compact = useIsCompactFormFactor();
  const { t } = useTranslation();
  const [repository, setRepository] = useState(request.repository);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => {
    if (!pending) dialog.setState({ request: null });
  }, [pending]);
  const submit = useCallback(async () => {
    if (pending || (request.action === "enable" && !validFactoryRepository(repository))) return;
    setPending(true);
    setError(null);
    try {
      const state = await request.invoke(`factory.project.${request.action}`, {
        projectId: request.projectId,
        ...(request.action === "enable" ? { repository } : {}),
      });
      request.onResult(state as ProjectFactoryState);
      dialog.setState({ request: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("projectFactory.failed"));
      setPending(false);
    }
  }, [pending, request, repository, t]);
  const onSubmit = useCallback(() => void submit(), [submit]);
  const header = useMemo(
    () => ({ title: t(`projectFactory.${request.action}`) }),
    [t, request.action],
  );
  const footer = useMemo(
    () => (
      <ActionFooter>
        <Button variant="secondary" onPress={close} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={onSubmit}
          disabled={pending || (request.action === "enable" && !validFactoryRepository(repository))}
        >
          {t(`projectFactory.${request.action}`)}
        </Button>
      </ActionFooter>
    ),
    [close, pending, t, onSubmit, request.action, repository],
  );
  return (
    <AdaptiveModalSheet visible onClose={close} header={header} footer={footer}>
      {request.action === "enable" ? (
        <>
          <Text style={textStyles.text}>{t("projectFactory.repository")}</Text>
          <FormTextInput
            size={compact ? "md" : "sm"}
            initialValue={request.repository}
            onChangeText={setRepository}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="owner/name"
            accessibilityLabel={t("projectFactory.repository")}
          />
          {repository && !validFactoryRepository(repository) ? (
            <Text style={textStyles.text}>{t("projectFactory.invalid")}</Text>
          ) : null}
        </>
      ) : (
        <Text style={textStyles.text}>{t("projectFactory.retained")}</Text>
      )}
      {error ? (
        <Text style={textStyles.text} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const textStyles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
