import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Platform, Text, View, StyleSheet } from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
// The app runs on expo-router's bundled React Navigation; the standalone package is a separate
// copy whose context is never provided, so importing hooks from it crashes at runtime.
import { NavigationContext } from "expo-router/react-navigation";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useToast } from "@/contexts/toast-context";
import {
  useAgentProfileFormModel,
  useAgentProfileFormState,
} from "../internal/use-profile-form-model";
import type { AgentProfileValue } from "../internal/profile-form-model";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { AgentProfileForm, type ProfileSharedScope } from "./agent-profile-form";
import { profileDraftKey, showProfileSaveBar } from "./agent-profile-page-model";

export interface AgentProfilePageProps {
  serverId: string;
  profile: AgentProfile;
  onBack: () => void;
  onSave: (value: AgentProfileValue) => Promise<void>;
  onDelete?: () => Promise<void>;
  sharedScope?: ProfileSharedScope;
  mode?: "create" | "edit";
  centered?: boolean;
  modelDetails?: (disabled: boolean) => ReactNode;
  additionalDirty?: boolean;
}
function confirmDiscard(leave: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm("Discard unsaved profile changes?")) leave();
  } else
    Alert.alert("Discard changes?", "Your unsaved profile changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: leave },
    ]);
}
/** Key this component by profile id so each editing session owns one draft. */
export function AgentProfilePage({
  serverId,
  profile,
  onBack,
  onSave,
  onDelete,
  centered,
  modelDetails,
  additionalDirty = false,
  sharedScope,
  mode = "edit",
}: AgentProfilePageProps) {
  const rawModel = useAgentProfileFormModel({
    mode,
    profile,
    sharedCatalog: Boolean(sharedScope && readExecutionInstallation()),
  });
  const touched = useRef(false);
  const model = useMemo(
    () =>
      new Proxy(rawModel, {
        get(target, key: keyof typeof rawModel) {
          const member = target[key];
          if (
            typeof member === "function" &&
            String(key).startsWith("set") &&
            key !== "setSubmitting" &&
            key !== "setSubmitError"
          ) {
            return (...args: unknown[]) => {
              touched.current = true;
              return (member as (...values: unknown[]) => unknown)(...args);
            };
          }
          return member;
        },
      }),
    [rawModel],
  );
  const state = useAgentProfileFormState(model);
  const [baseline, setBaseline] = useState(() => profileDraftKey(state));
  const draftKey = profileDraftKey(state);
  useEffect(() => {
    if (!touched.current) setBaseline(draftKey);
  }, [draftKey]);
  const dirty = additionalDirty || (touched.current && showProfileSaveBar(baseline, state));
  const allowLeave = useRef(false);
  // Null when the editor opens as a centered window outside a navigator (from the composer).
  const navigation = useContext(NavigationContext);
  const toast = useToast();
  useEffect(() => {
    if (!navigation) return;
    return navigation.addListener("beforeRemove", (event) => {
      if (!dirty || allowLeave.current) return;
      event.preventDefault();
      confirmDiscard(() => {
        allowLeave.current = true;
        navigation.dispatch(event.data.action);
      });
    });
  }, [navigation, dirty]);
  useEffect(() => {
    if (Platform.OS !== "web" || !dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const close = useCallback(() => {
    if (state.isSubmitting) return;
    if (dirty)
      confirmDiscard(() => {
        allowLeave.current = true;
        onBack();
      });
    else onBack();
  }, [state.isSubmitting, dirty, onBack]);
  const save = useCallback(async () => {
    if (!state.submitValue) return;
    const value = state.submitValue;
    model.setSubmitting(true);
    try {
      await onSave(value);
      setBaseline(profileDraftKey(model.getState()));
      toast.show("Profile saved");
      allowLeave.current = true;
      onBack();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "Could not save profile");
    } finally {
      model.setSubmitting(false);
    }
  }, [state.submitValue, model, onSave, onBack, toast]);
  const remove = useCallback(() => {
    if (!onDelete) return;
    const perform = async () => {
      model.setSubmitting(true);
      try {
        await onDelete();
        allowLeave.current = true;
        onBack();
      } catch (error) {
        toast.show(error instanceof Error ? error.message : "Could not delete profile");
      } finally {
        model.setSubmitting(false);
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete profile ${profile.name}?`)) perform();
    } else
      Alert.alert("Delete profile?", profile.name, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: perform },
      ]);
  }, [onDelete, onBack, toast, profile.name, model]);
  const header = useMemo(() => ({ title: profile.name || "New profile" }), [profile.name]);
  const actions = useMemo(
    () => (
      <View style={styles.actions}>
        <Button testID="agent-profile-cancel-button" onPress={close} disabled={state.isSubmitting}>
          Cancel
        </Button>
        <Button
          testID="agent-profile-save-button"
          onPress={save}
          disabled={!dirty || !state.canSubmit}
        >
          Save
        </Button>
      </View>
    ),
    [close, save, dirty, state.isSubmitting, state.canSubmit],
  );
  const deleteControl =
    onDelete && sharedScope?.kind !== "defaults" ? (
      <Button variant="ghost" onPress={remove} disabled={state.isSubmitting}>
        Delete profile
      </Button>
    ) : null;
  const form = (
    <AgentProfileForm
      serverId={serverId}
      profileId={profile.id}
      model={model}
      state={state}
      sharedScope={sharedScope}
      modelDetails={modelDetails}
    />
  );
  if (centered)
    return (
      <AdaptiveModalSheet
        visible
        testID="agent-profile-edit-modal"
        header={header}
        onClose={close}
        footer={actions}
      >
        <View style={styles.modalContent}>
          {form}
          {deleteControl}
        </View>
      </AdaptiveModalSheet>
    );
  return (
    <View testID="agent-profile-page" style={styles.container}>
      <ScrollView testID="agent-profile-page-scroll" contentContainerStyle={styles.content}>
        <Button testID="agent-profile-back-button" onPress={close}>
          Back to provider
        </Button>
        <Text accessibilityRole="header">{state.name || profile.name}</Text>
        {form}
        {deleteControl}
      </ScrollView>
      {dirty ? (
        <View testID="profile-save-bar" style={styles.saveBar}>
          {actions}
        </View>
      ) : null}
    </View>
  );
}
export function AgentProfileCenteredModal(props: Omit<AgentProfilePageProps, "centered">) {
  return <AgentProfilePage {...props} centered />;
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 12 },
  modalContent: { padding: 24 },
  container: { flex: 1, minHeight: 400 },
  content: { padding: 24, paddingBottom: 100 },
  saveBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
  },
});
