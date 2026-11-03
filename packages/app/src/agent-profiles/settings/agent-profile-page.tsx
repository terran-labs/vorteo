/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop -- These bounded form controls render with their draft; callbacks intentionally read the current draft. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useToast } from "@/contexts/toast-context";
import {
  useAgentProfileFormModel,
  useAgentProfileFormState,
} from "../internal/use-profile-form-model";
import type { AgentProfileValue } from "../internal/profile-form-model";
import { AgentProfileForm } from "./agent-profile-form";
import { profileDraftKey, showProfileSaveBar } from "./agent-profile-page-model";

export interface AgentProfilePageProps {
  serverId: string;
  profile: AgentProfile;
  onBack: () => void;
  onSave: (value: AgentProfileValue) => Promise<void>;
  onDelete: () => Promise<void>;
  centered?: boolean;
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
}: AgentProfilePageProps) {
  const rawModel = useAgentProfileFormModel({ mode: "edit", profile });
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
  const dirty = touched.current && showProfileSaveBar(baseline, state);
  const allowLeave = useRef(false);
  const navigation = useNavigation();
  const toast = useToast();
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (!dirty || allowLeave.current) return;
        event.preventDefault();
        confirmDiscard(() => {
          allowLeave.current = true;
          navigation.dispatch(event.data.action);
        });
      }),
    [navigation, dirty],
  );
  useEffect(() => {
    if (Platform.OS !== "web" || !dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const close = () => {
    if (state.isSubmitting) return;
    if (dirty)
      confirmDiscard(() => {
        allowLeave.current = true;
        onBack();
      });
    else onBack();
  };
  const save = async () => {
    if (!state.submitValue) return;
    const value = state.submitValue;
    model.setSubmitting(true);
    try {
      await onSave(value);
      setBaseline(profileDraftKey(model.getState()));
      toast.show("Profile saved");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "Could not save profile");
    } finally {
      model.setSubmitting(false);
    }
  };
  const remove = () => {
    const perform = () => {
      void onDelete()
        .then(() => {
          allowLeave.current = true;
          onBack();
          return undefined;
        })
        .catch((error) =>
          toast.show(error instanceof Error ? error.message : "Could not delete profile"),
        );
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete profile ${profile.name}?`)) perform();
    } else
      Alert.alert("Delete profile?", profile.name, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: perform },
      ]);
  };
  const content = (
    <View style={{ flex: 1, minHeight: 400 }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 100 }}>
        <Button onPress={close}>Back to provider</Button>
        <Text accessibilityRole="header">{state.name || profile.name}</Text>
        <AgentProfileForm serverId={serverId} profileId={profile.id} model={model} state={state} />
        <Button variant="ghost" onPress={remove} disabled={state.isSubmitting}>
          Delete profile
        </Button>
      </ScrollView>
      {dirty ? (
        <View
          testID="profile-save-bar"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: 16,
            flexDirection: "row",
            justifyContent: "flex-end",
            gap: 12,
          }}
        >
          <Button onPress={close} disabled={state.isSubmitting}>
            Cancel
          </Button>
          <Button onPress={() => void save()} disabled={!state.canSubmit}>
            Save
          </Button>
        </View>
      ) : null}
    </View>
  );
  return centered ? (
    <AdaptiveModalSheet visible header={{ title: profile.name }} onClose={close}>
      {content}
    </AdaptiveModalSheet>
  ) : (
    content
  );
}
export function AgentProfileCenteredModal(props: Omit<AgentProfilePageProps, "centered">) {
  return <AgentProfilePage {...props} centered />;
}
