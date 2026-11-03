import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ActionFooter } from "@/components/ui/action-footer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toErrorMessage } from "@/utils/error-messages";

/** Progress the owner reports while a switch that first stops the turn is underway. */
export type ProfileSwitchStage = "stopping" | "switching";

export interface ProfileSwitchRequest {
  /** Cancel the running turn, and decline its permission requests, before switching. */
  stopTurn: boolean;
  onStage: (stage: ProfileSwitchStage) => void;
}

interface ProfileSwitchSheetProps {
  profileName: string;
  /**
   * The thread has a running turn. The daemon refuses a plain switch then, so
   * the sheet offers to stop the turn first. A leftover permission request
   * without a running turn keeps the plain switch and the daemon's refusal.
   */
  busy: boolean;
  /** Resolves once the daemon accepts the switch; the owner then closes the sheet. */
  onSwitch: (request: ProfileSwitchRequest) => Promise<void>;
  onNewTask?: () => void;
  onClose: () => void;
}

type SwitchState =
  | { status: "idle" }
  | { status: "pending"; stage: ProfileSwitchStage }
  | { status: "failed"; error: string };

/** Confirms moving the current thread to another account instead of starting a successor task. */
export function ProfileSwitchSheet({
  profileName,
  busy,
  onSwitch,
  onNewTask,
  onClose,
}: ProfileSwitchSheetProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<SwitchState>({ status: "idle" });
  const pending = state.status === "pending";
  const header = useMemo(
    () => ({ title: t("message.profileSwitch.confirm.title", { name: profileName }) }),
    [t, profileName],
  );
  const close = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);
  const startNewTask = useCallback(() => {
    if (!pending) onNewTask?.();
  }, [pending, onNewTask]);
  const submit = useCallback(() => {
    if (pending) return;
    // Decide at press time: the busy flag clears mid-request once the stop lands.
    const stopTurn = busy;
    setState({ status: "pending", stage: stopTurn ? "stopping" : "switching" });
    onSwitch({
      stopTurn,
      onStage: (stage) =>
        setState((current) =>
          current.status === "pending" ? { status: "pending", stage } : current,
        ),
    }).catch((error: unknown) => setState({ status: "failed", error: toErrorMessage(error) }));
  }, [pending, busy, onSwitch]);
  let submitLabel = t("message.profileSwitch.confirm.switch");
  if (state.status === "pending") {
    submitLabel =
      state.stage === "stopping"
        ? t("message.profileSwitch.confirm.stopping")
        : t("message.profileSwitch.confirm.switching");
  } else if (busy) {
    submitLabel = t("message.profileSwitch.confirm.stopAndSwitch");
  }
  const footer = useMemo(
    () => (
      <ActionFooter style={styles.actions}>
        <Button variant="ghost" onPress={close} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        {onNewTask ? (
          <Button
            variant="outline"
            onPress={startNewTask}
            disabled={pending}
            testID="profile-switch-new-task"
          >
            {t("message.profileSwitch.confirm.newTask")}
          </Button>
        ) : null}
        <Button onPress={submit} loading={pending} testID="profile-switch-confirm">
          {submitLabel}
        </Button>
      </ActionFooter>
    ),
    [close, startNewTask, submit, pending, submitLabel, t, onNewTask],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={560}
      footer={footer}
      testID="profile-switch-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.text}>{t("message.profileSwitch.confirm.warning")}</Text>
        {busy && !pending ? (
          <Alert
            variant="warning"
            description={t("message.profileSwitch.confirm.busy")}
            testID="profile-switch-busy"
          />
        ) : null}
        {state.status === "failed" ? (
          <Alert variant="error" description={state.error} testID="profile-switch-error" />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
