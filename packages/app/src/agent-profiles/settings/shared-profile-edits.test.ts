import { openAgentProfileForm } from "../internal/profile-form-model";
import { expect, it } from "vitest";
import type { ProviderPreferences } from "@getpaseo/protocol/messages";
import { replaceProviderDefaults, editSharedProfile } from "./shared-profile-edits";

it("moves inherited worker settings to existing profiles without changing explicit overrides", () => {
  const group: ProviderPreferences = {
    defaults: { modeId: "auto", workerProfileId: "codex-worker", maxWorkers: 4 },
    workflows: [
      { id: "team", name: "Team", provider: "claude" },
      { id: "solo", name: "Solo", provider: "claude", workerProfileId: "" },
      {
        id: "other",
        name: "Other",
        provider: "claude",
        workerProfileId: "claude-worker",
        maxWorkers: 2,
      },
    ],
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "team",
  };
  const next = replaceProviderDefaults(group, { ...group.defaults, modeId: "default" });
  expect(next.defaults).toEqual({ modeId: "default" });
  expect(next.workflows).toEqual([
    { ...group.workflows[0], workerProfileId: "codex-worker", maxWorkers: 4 },
    { ...group.workflows[1], maxWorkers: 4 },
    group.workflows[2],
  ]);
  expect(group.defaults).toEqual({
    modeId: "auto",
    workerProfileId: "codex-worker",
    maxWorkers: 4,
  });
  expect(replaceProviderDefaults(next, next.defaults)).toEqual(next);
});

it("clears a profile skill override without pinning inherited settings or losing an explicit worker account", () => {
  const group: ProviderPreferences = {
    defaults: { modeId: "auto", skillPolicy: { mode: "none" } },
    workflows: [
      {
        id: "review",
        name: "Review",
        provider: "claude",
        skillPolicy: { mode: "selected", skills: ["old"] },
      },
    ],
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "review",
  };
  const model = openAgentProfileForm({
    mode: "edit",
    profile: { ...group.defaults, ...group.workflows[0] },
  });
  model.setSkillPolicy(undefined);
  model.setWorkerProfileId("shared-workflow/codex-two/worker");
  const saved = editSharedProfile(group, "review", "claude", model.getState().submitValue!);
  expect(saved.skillPolicy).toBeUndefined();
  expect(saved.modeId).toBeUndefined();
  expect(saved.workerProfileId).toBe("shared-workflow/codex-two/worker");
  expect(group.workflows[0].skillPolicy).toEqual({ mode: "selected", skills: ["old"] });
});

it("saves the exact installation account separately from the shared worker identity", () => {
  const group: ProviderPreferences = {
    defaults: {},
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "team",
    workflows: [{ id: "team", name: "Team", provider: "claude" }],
  };
  const model = openAgentProfileForm({ mode: "edit", profile: group.workflows[0] });
  model.setWorkerAccount("codex-two");
  model.setWorkerProfileId("shared-workflow/codex-two/worker");
  const saved = editSharedProfile(
    group,
    "team",
    "claude",
    model.getState().submitValue!,
    { "codex-two": { extends: "codex", installationAccountId: "account-two" } },
    true,
  );
  expect(saved.workerProfileId).toBe("shared-profile/codex/worker");
  expect(saved.workerAccount).toBe("installation-account/account-two");
  const reopened = openAgentProfileForm({ mode: "edit", profile: saved });
  const next = editSharedProfile(
    { ...group, workflows: [saved] },
    "team",
    "claude",
    reopened.getState().submitValue!,
  );
  expect(next.workerAccount).toBe(saved.workerAccount);
  reopened.setWorkerAccount("");
  const cleared = editSharedProfile(
    { ...group, workflows: [saved] },
    "team",
    "claude",
    reopened.getState().submitValue!,
  );
  expect(cleared.workerAccount).toBeUndefined();
  expect(cleared.workerProfileId).toBe("");
});

it("preserves uncapped worker inheritance while moving delegation out of defaults", () => {
  const group = {
    defaults: { workerProfileId: "worker", uncappedWorkers: true },
    workflows: [{ id: "team", name: "Team", provider: "codex" }],
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: null,
  };
  const changed = replaceProviderDefaults(group, { model: "gpt-5.4" });
  expect(changed.workflows[0].uncappedWorkers).toBe(true);
  expect(changed.defaults.uncappedWorkers).toBe(false);
  expect(replaceProviderDefaults(changed, changed.defaults)).toEqual(changed);
});

it("round-trips workflow reasoning and keeps workflows without it on the model default", () => {
  const catalog = [
    {
      provider: "claude",
      label: "Claude",
      status: "ready" as const,
      enabled: true,
      modes: [],
      models: [
        {
          provider: "claude",
          id: "claude-fable-5-2",
          label: "Fable 5.2",
          isDefault: true,
          defaultThinkingOptionId: "medium",
          thinkingOptions: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "ultracode", label: "Ultra Code" },
          ],
        },
      ],
    },
  ];
  const group: ProviderPreferences = {
    defaults: { model: "claude-fable-5-2" },
    workflows: [{ id: "fable", name: "Fable", provider: "claude" }],
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "fable",
  };
  const open = (profile: ProviderPreferences["workflows"][number]) => {
    const model = openAgentProfileForm({
      mode: "edit",
      inheritThinking: true,
      profile: { ...group.defaults, ...profile },
    });
    model.applyProviderCatalog(catalog);
    return model;
  };
  // A workflow saved before reasoning was editable stays on the model default.
  const legacy = open(group.workflows[0]);
  expect(legacy.getState().thinkingOptionId).toBe("");
  expect(legacy.getState().thinkingDisplay?.label).toBe("Model default (Medium)");
  expect(
    editSharedProfile(group, "fable", "claude", legacy.getState().submitValue!),
  ).not.toHaveProperty("thinkingOptionId");

  legacy.setThinking("ultracode", { label: "Ultra Code" });
  const ultra = editSharedProfile(group, "fable", "claude", legacy.getState().submitValue!);
  expect(ultra.thinkingOptionId).toBe("ultracode");
  const reopened = open(ultra);
  expect(reopened.getState().thinkingOptionId).toBe("ultracode");

  // Model default overrides a provider default level with an explicit empty choice.
  reopened.setThinking("", null);
  const withLevel = { ...group, defaults: { ...group.defaults, thinkingOptionId: "medium" } };
  expect(
    editSharedProfile(withLevel, "fable", "claude", reopened.getState().submitValue!)
      .thinkingOptionId,
  ).toBe("");
});
