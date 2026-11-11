import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { VorteoLogo } from "@/components/icons/paseo-logo";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useToast } from "@/contexts/toast-context";
import { useProjectSuggestions } from "@/project-suggestions";
import { settingsStyles } from "@/styles/settings";
import type { OnboardingState, OnboardingStepId } from "../internal/model";
import type { VorteoGuideModel } from "./model";
import { GuideStep } from "./steps";

export function VorteoGuideView({
  model,
  state,
}: {
  model: VorteoGuideModel;
  state: Extract<OnboardingState, { status: "open" }>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const suggestions = useProjectSuggestions(state.serverId);
  const step = state.steps[state.stepIndex];
  const last = state.stepIndex === state.steps.length - 1;
  const skip = useCallback(() => {
    void model.skip().catch(() => toast.error(t("vorteoSetup.saveFailed")));
  }, [model, toast, t]);
  const advance = useCallback(() => {
    void (async () => {
      if (step === "projects" && suggestions.checkedCount > 0 && !(await suggestions.addChecked()))
        return;
      // next checks the visit token, including when project admission finishes after closing.
      const current = model.getState();
      if (current.status !== "open" || current.visit !== state.visit) return;
      if (last) await model.complete();
      else model.next(state.visit);
    })().catch(() => toast.error(t("vorteoSetup.saveFailed")));
  }, [step, suggestions, model, state.visit, last, toast, t]);
  const back = useCallback(() => model.back(), [model]);
  const adding = step === "projects" && suggestions.checkedCount > 0;
  let primary = t("onboarding.setup.continue");
  if (last) primary = t("onboarding.setup.finish");
  if (adding)
    primary = t("onboarding.setup.steps.projects.suggestions.addSelected", {
      count: suggestions.checkedCount,
    });

  const header = useMemo(
    () => ({
      title: t("vorteoSetup.title"),
      leading: <VorteoLogo size={28} />,
      subtitle: (
        <Text style={settingsStyles.rowHint}>
          {t("vorteoSetup.stepCounter", {
            current: state.stepIndex + 1,
            total: state.steps.length,
          })}
        </Text>
      ),
    }),
    [t, state.stepIndex, state.steps.length],
  );

  return (
    <AdaptiveModalSheet
      accessibilityLabel={t("vorteoSetup.title")}
      visible
      onClose={skip}
      header={header}
      footer={
        <>
          <Button variant="outline" onPress={skip}>
            {t("onboarding.setup.skip")}
          </Button>
          {state.stepIndex > 0 ? <Button onPress={back}>{t("common.actions.back")}</Button> : null}
          <Button variant="default" onPress={advance} loading={suggestions.isAdding}>
            {primary}
          </Button>
        </>
      }
      snapPoints={FULL_SHEET_SNAP_POINTS}
      desktopMaxWidth={800}
      desktopHeight={680}
      testID="vorteo-setup-guide"
    >
      <View style={styles.content}>
        <DropdownMenu>
          <DropdownTrigger
            accessibilityLabel={t("vorteoSetup.chooseStepCurrent", {
              step: t(`vorteoSetup.${step}`),
            })}
          >
            {t(`vorteoSetup.${step}`)}
          </DropdownTrigger>
          <DropdownMenuContent width={260}>
            {state.steps.map((option) => (
              <StepLink key={option} step={option} model={model} selected={option === step} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <GuideStep step={step} serverId={state.serverId} model={model} suggestions={suggestions} />
      </View>
    </AdaptiveModalSheet>
  );
}

function StepLink({
  step,
  model,
  selected,
}: {
  step: OnboardingStepId;
  model: VorteoGuideModel;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => model.goTo(step), [model, step]);
  return (
    <DropdownMenuItem onSelect={select} selected={selected}>
      {t(`vorteoSetup.${step}`)}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4], padding: theme.spacing[4] },
}));
