import type { Theme } from "@/styles/theme";
import { useMemo } from "react";
import type { AgentScreenReadySyncState } from "@/hooks/use-agent-screen-state-machine";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ToastViewport, type ToastState } from "@/components/toast-host";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

const spinnerColor = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const keepUntilSynchronized = () => {};

/** A history catch-up that failed; Retry asks for the missed history again. */
export interface TimelineSyncError {
  isRetrying: boolean;
  onRetry: () => void;
}

/**
 * Floats timeline sync notices over the conversation, so they never move the message field.
 * An action toast replaces a notice only while it shows.
 */
export function TimelineSyncStatus({
  sync,
  error,
  toast,
  onDismiss,
}: {
  sync: AgentScreenReadySyncState | null;
  error: TimelineSyncError | null;
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  let state: "reconnecting" | "updating" | null = null;
  if (sync?.status === "reconnecting") state = "reconnecting";
  else if (sync?.status === "catching_up" && sync.ui === "status") state = "updating";
  const label = state ? t(`agentPanel.states.${state}`) : null;
  const syncToast = useMemo<ToastState | null>(
    () =>
      state && label
        ? {
            id: state === "reconnecting" ? 1 : 2,
            content: label,
            nativeMessage: label,
            icon: <ThemedLoadingSpinner size={18} uniProps={spinnerColor} />,
            variant: "default",
            durationMs: null,
            testID: `agent-${state}-toast`,
          }
        : null,
    [state, label],
  );
  const isRetrying = error?.isRetrying ?? false;
  const onRetry = error?.onRetry;
  const errorToast = useMemo<ToastState | null>(() => {
    if (!onRetry) return null;
    const message = t("agentPanel.states.timelineSyncFailed");
    return {
      id: 3,
      content: (
        <View style={styles.errorRow}>
          <Text style={styles.errorText}>{message}</Text>
          <Button
            variant="secondary"
            size="sm"
            onPress={onRetry}
            disabled={isRetrying}
            testID="agent-timeline-sync-retry"
          >
            {isRetrying ? t("agentPanel.states.timelineSyncRetrying") : t("common.actions.retry")}
          </Button>
        </View>
      ),
      nativeMessage: message,
      variant: "error",
      durationMs: null,
      testID: "agent-timeline-sync-error",
    };
  }, [isRetrying, onRetry, t]);
  return (
    <ToastViewport
      toast={toast ?? errorToast ?? syncToast}
      onDismiss={toast ? onDismiss : keepUntilSynchronized}
      placement="panel"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  errorText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
