import type { AgentProfileFormState } from "../internal/profile-form-model";
/** Only editable values count, never asynchronous labels or submission state. */
export function profileDraftKey(state: AgentProfileFormState): string {
  return JSON.stringify([
    state.name,
    state.icon,
    state.color,
    state.nickname,
    state.provider,
    state.modelId,
    state.modeId,
    state.thinkingOptionId,
    state.featureValues,
    state.instructions,
    state.notes,
    state.skillPolicy,
    state.workerProfileId,
    state.workerAccountId,
    state.maxWorkers,
    [...state.excludedEnvironments].sort(),
  ]);
}
export function showProfileSaveBar(baseline: string, state: AgentProfileFormState): boolean {
  return baseline !== profileDraftKey(state);
}
export function parseProfileRoute(params: {
  profileId?: string | string[];
  providerType?: string | string[];
  serverId?: string | string[];
}) {
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || null;
  return {
    profileId: one(params.profileId),
    providerType: one(params.providerType),
    serverId: one(params.serverId),
  };
}
