// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { MutableDaemonConfig, SharedProviderPreferences } from "@getpaseo/protocol/messages";
import { useSharedProviderProfiles } from "./use-shared-provider-profiles";
const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  save: vi.fn(),
  config: {} as Partial<MutableDaemonConfig>,
  installation: false,
  snapshot: undefined as
    | { revision: number; providers: SharedProviderPreferences["providers"] }
    | undefined,
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: mocks.config, patchConfig: mocks.patch }),
}));
vi.mock("@/execution-installation/profiles", () => ({
  useInstallationProfiles: () => ({
    installation: mocks.installation ? { installationId: "installation" } : null,
    data: mocks.snapshot,
    save: mocks.save,
    error: null,
  }),
}));
const original: SharedProviderPreferences = {
  version: 1,
  revision: 7,
  providers: {
    claude: {
      defaults: { model: "shared-model", workerProfileId: "worker", maxWorkers: 4 },
      preferredModels: ["shared-model"],
      preferredThinkingOptions: [],
      workflows: [
        { id: "workflow", name: "Shared workflow", provider: "claude" },
        { id: "second", name: "Second", provider: "claude" },
      ],
      defaultWorkflowId: "workflow",
    },
  },
  legacyProfiles: {},
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.patch.mockResolvedValue(true);
  mocks.save.mockResolvedValue({});
  mocks.installation = false;
  mocks.snapshot = undefined;
  mocks.config = {
    providers: { "claude-account": { extends: "claude" } },
    sharedProviderPreferences: structuredClone(original),
    agentProfiles: [{ id: "local", name: "Wrong source", provider: "claude-account" }],
  };
});
it("reads shared workflows through provider ancestry rather than local profiles", () => {
  const { result } = renderHook(() => useSharedProviderProfiles("host", "claude-account"));
  expect(result.current.providerType).toBe("claude");
  expect(result.current.ready).toBe(true);
  expect(result.current.group?.workflows.map((item) => item.id)).toEqual(["workflow", "second"]);
});
it("saves the captured standalone revision even after a poll", async () => {
  const { result, rerender } = renderHook(() =>
    useSharedProviderProfiles("host", "claude-account"),
  );
  const snapshot = result.current.shared!;
  mocks.config = { ...mocks.config, sharedProviderPreferences: { ...original, revision: 8 } };
  rerender();
  await result.current.saveWorkflow(
    { id: "workflow", name: "Edited", provider: "claude-account", model: "other-model" },
    snapshot,
  );
  const patch = mocks.patch.mock.calls[0][0];
  expect(patch.expectedProviderPreferencesRevision).toBe(7);
  expect(patch.agentProfiles).toBeUndefined();
  expect(patch.sharedProviderPreferences.providers.claude.workflows[0]).toMatchObject({
    id: "workflow",
    name: "Edited",
    provider: "claude",
    model: "other-model",
  });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(snapshot).toEqual(original);
});
it("uses installation workflows and installation revision for saves", async () => {
  mocks.installation = true;
  mocks.snapshot = {
    revision: 12,
    providers: { claude: { ...original.providers.claude, defaultWorkflowId: null, workflows: [] } },
  };
  const { result } = renderHook(() => useSharedProviderProfiles("host", "claude-account"));
  expect(result.current.group?.workflows).toEqual([]);
  await result.current.saveWorkflow(
    { id: "new", name: "New", provider: "claude-account" },
    result.current.shared!,
  );
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 12 }));
  expect(mocks.save.mock.calls[0][0].providers.claude).toMatchObject({
    defaultWorkflowId: "new",
    workflows: [{ id: "new", name: "New", provider: "claude" }],
  });
  expect(mocks.patch).not.toHaveBeenCalled();
});
it("does not fall back to local preferences while installation data is missing", () => {
  mocks.installation = true;
  const { result } = renderHook(() => useSharedProviderProfiles("host", "claude-account"));
  expect(result.current.ready).toBe(false);
  expect(result.current.shared).toBeUndefined();
});
it("saves defaults without identity and preserves existing worker teams", async () => {
  const { result } = renderHook(() => useSharedProviderProfiles("host", "claude-account"));
  await result.current.saveDefaults(
    {
      name: "Ignored",
      provider: "claude-account",
      nickname: "Ignored",
      notes: "Ignored",
      model: "new-model",
      workerProfileId: "ignored",
      maxWorkers: 10,
    },
    original,
  );
  const group = mocks.patch.mock.calls[0][0].sharedProviderPreferences.providers.claude;
  expect(group.defaults).toEqual({ model: "new-model" });
  expect(group.workflows[0]).toMatchObject({ workerProfileId: "worker", maxWorkers: 4 });
  expect(group.preferredModels).toEqual(["shared-model"]);
});
it("deletes workflows and selects the next default", async () => {
  const { result } = renderHook(() => useSharedProviderProfiles("host", "claude-account"));
  await result.current.deleteWorkflow("workflow", original);
  expect(mocks.patch.mock.calls[0][0].sharedProviderPreferences.providers.claude).toMatchObject({
    defaultWorkflowId: "second",
    workflows: [original.providers.claude.workflows[1]],
  });
});
it("protects legacy bindings and maps conflict messages", async () => {
  const { result } = renderHook(() => useSharedProviderProfiles("host", "claude-account"));
  const linked = {
    ...original,
    legacyProfiles: {
      legacy: { provider: "claude-account", providerType: "claude", workflowId: "workflow" },
    },
  };
  await expect(result.current.deleteWorkflow("workflow", linked)).rejects.toThrow(
    "Older launches and workers",
  );
  expect(mocks.patch).not.toHaveBeenCalled();
  mocks.patch.mockRejectedValue(
    Object.assign(new Error("Transport wrapper"), {
      userMessage: "Request failed: Preferences changed. Reopen the editor.",
    }),
  );
  await expect(
    result.current.saveWorkflow({ id: "workflow", name: "Edited", provider: "claude" }, original),
  ).rejects.toThrow("Preferences changed. Reopen the editor.");
});
it("reports missing standalone save acknowledgement", async () => {
  mocks.patch.mockResolvedValue(undefined);
  const { result } = renderHook(() => useSharedProviderProfiles("host", "claude-account"));
  await expect(
    result.current.saveDefaults({ name: "Defaults", provider: "claude" }, original),
  ).rejects.toThrow("Reconnect");
});
