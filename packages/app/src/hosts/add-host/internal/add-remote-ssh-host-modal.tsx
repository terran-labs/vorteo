import { ActionFooter } from "@/components/ui/action-footer";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Terminal } from "lucide-react-native";
import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";
import type { HostProfile } from "@/types/host-connection";
import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { CONTROL_HEIGHTS, createControlGeometry } from "@/components/ui/control-geometry";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";

const ThemedTerminal = withUnistyles(Terminal);

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);
  return {
    helper: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    passwordRow: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "stretch",
      width: "100%",
      gap: theme.spacing[2],
    },
    passwordInputWrap: {
      flex: 1,
      minWidth: 0,
    },
    // Boxed adornment next to the field: same height and radius as the field
    // chrome, and the shared interaction phases.
    iconButton: {
      minHeight: CONTROL_HEIGHTS.md,
      width: CONTROL_HEIGHTS.md,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.surface2,
    },
    controlRest: {
      ...geometry.controlRest,
    },
    controlHover: {
      ...geometry.controlHover,
    },
    controlActive: {
      ...geometry.controlActive,
    },
    controlDisabled: {
      ...geometry.controlDisabled,
    },
    actions: {
      flexDirection: "row",
      gap: theme.spacing[3],
      marginTop: theme.spacing[2],
    },
  };
});

export interface AddRemoteSshHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function AddRemoteSshHostModal({
  visible,
  onClose,
  onCancel,
  onSaved,
}: AddRemoteSshHostModalProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { probeAndUpsertRemoteSshConnection } = useHostMutations();
  const targetRef = useRef("");
  const passwordRef = useRef("");
  const inputRef = useRef<EditingTextInputHandle>(null);
  const passwordInputRef = useRef<EditingTextInputHandle>(null);
  const [, setIsPasswordVisible] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.remoteSsh.title") }), [t]);

  const clear = useCallback(() => {
    targetRef.current = "";
    passwordRef.current = "";
    inputRef.current?.replaceText("");
    passwordInputRef.current?.replaceText("");
    setIsPasswordVisible(false);
    setErrorMessage("");
  }, []);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clear();
    onClose();
  }, [clear, isSaving, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    clear();
    (onCancel ?? onClose)();
  }, [clear, isSaving, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const rawTarget = targetRef.current.trim();
    if (!rawTarget) {
      setErrorMessage(t("pairing.remoteSsh.errors.targetRequired"));
      return;
    }

    let target: ReturnType<typeof parseSshTransportUri>;
    try {
      target = parseSshTransportUri(rawTarget);
    } catch {
      setErrorMessage(t("pairing.remoteSsh.errors.invalidTarget"));
      return;
    }

    let result: Awaited<ReturnType<typeof probeAndUpsertRemoteSshConnection>>;
    try {
      setIsSaving(true);
      setErrorMessage("");
      result = await probeAndUpsertRemoteSshConnection({
        ...target,
        password: passwordRef.current === "" ? undefined : passwordRef.current,
      });
    } catch (error) {
      const message =
        error instanceof DaemonConnectionTestError
          ? t("pairing.remoteSsh.errors.failedToConnect", { detail: error.message })
          : t("common.errors.unableToSave");
      setErrorMessage(message);
      return;
    } finally {
      setIsSaving(false);
    }

    clear();
    onSaved?.({
      ...result,
      isNewHost: !hosts.some((profile) => profile.serverId === result.serverId),
    });
    onClose();
  }, [clear, hosts, isSaving, onClose, onSaved, probeAndUpsertRemoteSshConnection, t]);
  const handleTargetChange = useCallback((value: string) => {
    targetRef.current = value;
  }, []);

  const handleSubmit = useCallback(() => void handleSave(), [handleSave]);

  const modalFooter1 = useMemo(
    () => (
      <ActionFooter style={styles.actions}>
        <Button variant="secondary" onPress={handleCancel} disabled={isSaving}>
          {t("pairing.remoteSsh.actions.cancel")}
        </Button>
        <Button
          onPress={handleSubmit}
          disabled={isSaving}
          leftIcon={ThemedTerminal}
          testID="remote-ssh-submit"
        >
          {isSaving
            ? t("pairing.remoteSsh.actions.connecting")
            : t("pairing.remoteSsh.actions.connect")}
        </Button>
      </ActionFooter>
    ),
    [handleCancel, isSaving, t, handleSubmit],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="add-remote-ssh-host-modal"
      footer={modalFooter1}
    >
      <Text style={styles.helper}>{t("pairing.remoteSsh.helper")}</Text>
      <Field
        label={t("pairing.remoteSsh.fields.target")}
        error={errorMessage}
        testID="remote-ssh-target"
      >
        <FormTextInput
          ref={inputRef}
          testID="remote-ssh-target-input"
          accessibilityLabel={t("pairing.remoteSsh.fields.target")}
          initialValue=""
          onChangeText={handleTargetChange}
          placeholder="ssh://user@host"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
      </Field>
    </AdaptiveModalSheet>
  );
}
