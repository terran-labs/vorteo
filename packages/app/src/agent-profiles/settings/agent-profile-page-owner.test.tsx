import type { AgentProfile } from "@getpaseo/protocol/messages";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { cloneElement, type ReactNode } from "react";
import { AgentProfilePage } from "./agent-profile-page";
const profile: AgentProfile = { id: "profile", name: "Profile", provider: "claude" };
const owner = vi.hoisted(() => ({ status: "locked" }));
vi.mock("@/execution-installation/owner-access", () => ({ useOwnerAccess: () => owner }));
vi.mock("@/components/settings/owner-lock", () => ({ OwnerLockBadge: () => <span>Unlock</span> }));
vi.mock("expo-router/react-navigation", async () => {
  const { createContext } = await import("react");
  return { NavigationContext: createContext<unknown>({ addListener: () => () => {} }) };
});
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("@/execution-installation/policy", () => ({ readExecutionInstallation: () => ({}) }));
vi.mock("./agent-profile-form", () => ({ AgentProfileForm: () => <div>Profile fields</div> }));
vi.mock("@/components/adaptive-modal-sheet", () => ({ AdaptiveModalSheet: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress(): void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../internal/use-profile-form-model", async () => {
  const { openAgentProfileForm } = await import("../internal/profile-form-model");
  const model = openAgentProfileForm({
    mode: "edit",
    profile: { id: "profile", name: "Profile", provider: "claude" },
  });
  return {
    useAgentProfileFormModel: () => model,
    useAgentProfileFormState: () => ({ ...model.getState(), canSubmit: true }),
  };
});
afterEach(cleanup);
it.each(["checking", "locked"])(
  "disables Save and Delete until owner unlock while %s",
  (status) => {
    owner.status = status;
    const save = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const page = (
      <AgentProfilePage
        serverId="host"
        profile={profile}
        onSave={save}
        onDelete={remove}
        onBack={vi.fn()}
        additionalDirty
      />
    );
    const result = render(page);
    const saveButton = screen.getByRole("button", { name: "Save" });
    const deleteButton = screen.getByRole("button", { name: "Delete profile" });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    expect(deleteButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(saveButton);
    fireEvent.click(deleteButton);
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText("Unlock")).toBeTruthy();
    owner.status = "unlocked";
    result.rerender(cloneElement(page));
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    expect(deleteButton.hasAttribute("disabled")).toBe(false);
  },
);

it("keeps Unlock beside Delete before there are any unsaved edits", () => {
  owner.status = "locked";
  render(
    <AgentProfilePage
      serverId="host"
      profile={profile}
      onSave={vi.fn()}
      onDelete={vi.fn()}
      onBack={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.getByRole("button", { name: "Delete profile" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByText("Unlock")).toBeTruthy();
});
