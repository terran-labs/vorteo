// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { AgentProfile, SharedProviderPreferences } from "@getpaseo/protocol/messages";
import type { AgentProfilePageProps } from "./settings/agent-profile-page";
import { AgentProfileCenteredModal } from "./settings/agent-profile-page";
import { useAgentProfileEditor } from "./agent-profile-editor";
const mocks = vi.hoisted(() => ({
  profiles: [] as AgentProfile[],
  shared: undefined as SharedProviderPreferences | undefined,
  supported: false,
  save: vi.fn(),
  saveWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
}));
vi.mock("./settings/agent-profile-page", () => ({ AgentProfileCenteredModal: () => null }));
vi.mock("./internal/use-agent-profiles", () => ({
  useAgentProfiles: () => ({
    profiles: mocks.profiles,
    legacyProfiles: mocks.profiles,
    saveProfiles: mocks.save,
    supportsSharedPreferences: mocks.supported,
  }),
}));
vi.mock("./settings/use-shared-provider-profiles", () => ({
  useSharedProviderProfiles: () => ({
    shared: mocks.shared,
    providerType: "mock",
    saveWorkflow: mocks.saveWorkflow,
    deleteWorkflow: mocks.deleteWorkflow,
  }),
}));
const original = { id: "one", name: "Original", provider: "mock" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profiles = [original];
  mocks.supported = false;
  mocks.shared = undefined;
});
afterEach(cleanup);
function props(element: ReactElement | null) {
  return element!.props as AgentProfilePageProps;
}
it("opens the centered composer editor and saves a seeded new profile", async () => {
  const { result } = renderHook(() => useAgentProfileEditor("host"));
  act(() => result.current.openCreateFromModel({ provider: "mock", modelId: "m", name: "Seed" }));
  expect(result.current.element?.type).toBe(AgentProfileCenteredModal);
  const editor = props(result.current.element);
  expect(editor.profile).toMatchObject({ name: "Seed", provider: "mock", model: "m" });
  expect(editor.onDelete).toBeUndefined();
  await act(() => editor.onSave({ name: "Saved", provider: "mock", model: "m" }));
  expect(mocks.save).toHaveBeenCalledWith([
    original,
    { id: editor.profile.id, name: "Saved", provider: "mock", model: "m" },
  ]);
  expect(result.current.element).toBeNull();
});
it("keeps an open draft on a conflicting save or delete", async () => {
  const { result, rerender } = renderHook(() => useAgentProfileEditor("host"));
  act(() => result.current.openEdit("one"));
  mocks.profiles = [{ ...original, name: "Another client" }];
  rerender();
  await expect(
    props(result.current.element).onSave({ name: "Draft", provider: "mock" }),
  ).rejects.toThrow("changed");
  await expect(props(result.current.element).onDelete!()).rejects.toThrow("changed");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(props(result.current.element).profile.name).toBe("Original");
});
it("deletes a legacy profile through the existing local write path", async () => {
  const { result } = renderHook(() => useAgentProfileEditor("host"));
  act(() => result.current.openEdit("one"));
  await act(() => props(result.current.element).onDelete!());
  expect(mocks.save).toHaveBeenCalledWith([]);
});
it("uses the reviewed shared revision for composer workflow saves and deletes", async () => {
  mocks.supported = true;
  const snapshot = {
    version: 1,
    revision: 7,
    providers: {},
    legacyProfiles: {},
  } as SharedProviderPreferences;
  mocks.shared = snapshot;
  mocks.profiles = [{ ...original, id: "shared-profile/mock/workflow" }];
  const { result, rerender } = renderHook(() => useAgentProfileEditor("host"));
  act(() => result.current.openEdit(mocks.profiles[0].id));
  mocks.shared = { ...snapshot, revision: 8 };
  rerender();
  await act(() => props(result.current.element).onSave({ name: "Draft", provider: "mock" }));
  expect(mocks.saveWorkflow).toHaveBeenCalledWith(
    { id: "workflow", name: "Draft", provider: "mock" },
    snapshot,
  );
  act(() => result.current.openEdit(mocks.profiles[0].id));
  const reviewed = mocks.shared;
  await act(() => props(result.current.element).onDelete!());
  expect(mocks.deleteWorkflow).toHaveBeenCalledWith("workflow", reviewed);
  expect(mocks.save).not.toHaveBeenCalled();
});
