import type { AgentProfile, ProviderPreferences } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { filterSelectableModels, findModelByReference } from "@/provider-selection/model-catalog";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";

export interface LaunchChoices {
  provider?: string;
  model?: string;
  thinkingOptionId?: string;
}

interface ChoiceOption {
  id: string;
  value: string;
  label: string;
  available: boolean;
}

function rankedOptions(options: Map<string, ChoiceOption>, preferred: readonly string[]) {
  const ranks = new Map(preferred.map((id, index) => [id, index]));
  return [...options.values()].sort(
    (left, right) =>
      (ranks.get(left.id) ?? preferred.length) - (ranks.get(right.id) ?? preferred.length),
  );
}

function catalogChoices(input: {
  model: string;
  entry: Pick<ProviderSnapshotEntry, "models"> | undefined;
  family: readonly Pick<ProviderSnapshotEntry, "models">[];
  preferences: ProviderPreferences | undefined;
}) {
  const models = filterSelectableModels(input.entry?.models ?? null);
  const current = findModelByReference(models, input.model);
  const familyModels = input.family.flatMap(
    (entry) => filterSelectableModels(entry.models ?? null) ?? [],
  );
  const modelOptions = new Map<string, ChoiceOption>();
  const thinkingOptions = new Map<string, ChoiceOption>();
  for (const model of familyModels) {
    modelOptions.set(model.id, {
      id: model.id,
      value: model.id,
      label: model.label,
      available: findModelByReference(models, model.id) !== null,
    });
  }
  // Resolve each account independently so an exact ID wins over a colliding alias.
  for (const entry of input.family) {
    const selected = findModelByReference(
      filterSelectableModels(entry.models ?? null),
      input.model,
    );
    for (const option of selected?.thinkingOptions ?? []) {
      thinkingOptions.set(option.id, {
        id: option.id,
        value: option.id,
        label: option.label,
        available: Boolean(
          current?.thinkingOptions?.some((candidate) => candidate.id === option.id),
        ),
      });
    }
  }
  const defaultLevel = effectiveReasoning({ entry: input.entry, model: input.model });
  return {
    modelOptions: rankedOptions(modelOptions, input.preferences?.preferredModels ?? []),
    thinkingOptions: [
      {
        id: "provider-default",
        value: "",
        label: defaultLevel ? `Model default (${defaultLevel.label})` : "Model default",
        available: true,
      },
      ...rankedOptions(thinkingOptions, input.preferences?.preferredThinkingOptions ?? []),
    ],
  };
}

export function profileCatalogState(
  entry: Pick<ProviderSnapshotEntry, "models" | "status"> | undefined,
) {
  if (!entry || entry.status === "loading") return "loading";
  if (entry.status !== "ready" || !entry.models) return "error";
  return "ready";
}

function choiceErrors(input: {
  model: string;
  thinkingOptionId: string;
  entry: Pick<ProviderSnapshotEntry, "models" | "status"> | undefined;
}) {
  if (profileCatalogState(input.entry) !== "ready")
    return { modelError: null, thinkingError: null };
  const selectable = filterSelectableModels(input.entry?.models ?? null) ?? [];
  const selected = input.model
    ? findModelByReference(selectable, input.model)
    : (selectable.find((model) => model.isDefault) ?? selectable[0]);
  if (input.model && !selected)
    return {
      modelError: `Model ${input.model} is not offered by this account.`,
      thinkingError: null,
    };
  const supported = selected?.thinkingOptions?.some(
    (option) => option.id === input.thinkingOptionId,
  );
  const thinkingError =
    input.thinkingOptionId && !supported
      ? `Reasoning level ${input.thinkingOptionId} is not offered for ${selected?.label ?? "the default model"} on this account.`
      : null;
  return { modelError: null, thinkingError };
}

export function sharedChoiceState(input: {
  profile: AgentProfile;
  choices: LaunchChoices;
  entry: Pick<ProviderSnapshotEntry, "models" | "status"> | undefined;
  family?: readonly Pick<ProviderSnapshotEntry, "models">[];
  preferences?: ProviderPreferences;
}) {
  const model = input.choices.model ?? input.profile.model ?? "";
  const thinkingOptionId = input.choices.thinkingOptionId ?? input.profile.thinkingOptionId ?? "";
  const selectedModel = findModelByReference(
    filterSelectableModels(input.entry?.models ?? null),
    model,
  );
  const family = input.family ?? [input.entry ?? { models: [] }];
  const { modelOptions, thinkingOptions } = catalogChoices({
    model,
    entry: input.entry,
    family,
    preferences: input.preferences,
  });
  const errors = choiceErrors({ model, thinkingOptionId, entry: input.entry });
  return {
    choices: { model, thinkingOptionId },
    modelOptions,
    thinkingOptions,
    modelDisplay: { label: selectedModel?.label ?? model },
    thinkingDisplay: {
      label:
        thinkingOptions.find((option) => option.value === thinkingOptionId)?.label ??
        thinkingOptionId,
    },
    ...errors,
    unavailable: Boolean(errors.modelError || errors.thinkingError),
  };
}

/** An unset model resolves to the catalog's default, as the daemon does at launch. */
function effectiveModel(
  entry: Pick<ProviderSnapshotEntry, "models"> | undefined,
  modelId: string | null | undefined,
) {
  const models = filterSelectableModels(entry?.models ?? null) ?? [];
  const id = modelId?.trim();
  if (id) return findModelByReference(models, id);
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

/** The reasoning a launch would use on this account: the explicit level or the model default. */
export function effectiveReasoning(input: {
  entry: Pick<ProviderSnapshotEntry, "models"> | undefined;
  model?: string | null;
  thinkingOptionId?: string | null;
}): { id: string; label: string } | null {
  const model = effectiveModel(input.entry, input.model);
  const id =
    input.thinkingOptionId?.trim() ||
    model?.defaultThinkingOptionId ||
    model?.thinkingOptions?.find((option) => option.isDefault)?.id;
  if (!id) return null;
  const option = model?.thinkingOptions?.find((entry) => entry.id === id);
  return { id, label: formatThinkingOptionLabel(option ?? { id }) };
}

/** "Fable 5.2 · Medium": the picker summary for a profile on one account. */
export function profileLaunchSummary(input: {
  entry: Pick<ProviderSnapshotEntry, "models"> | undefined;
  profile: Pick<AgentProfile, "model" | "thinkingOptionId"> | undefined;
}): string {
  const modelId = input.profile?.model?.trim();
  const model = effectiveModel(input.entry, modelId);
  const reasoning = effectiveReasoning({
    entry: input.entry,
    model: input.profile?.model,
    thinkingOptionId: input.profile?.thinkingOptionId,
  });
  return [model?.label ?? (modelId || "Provider default model"), reasoning?.label]
    .filter(Boolean)
    .join(" · ");
}
