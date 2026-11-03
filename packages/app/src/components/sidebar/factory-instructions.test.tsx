/** @vitest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FactoryInstructionsPanel, openFactoryInstructions } from "./factory-instructions";
vi.mock("./factory-model-controls", () => ({ FactoryModelControls: () => null }));
const fixture = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugins: () => [{ id: "factory", serverId: "host", invoke: fixture.invoke }],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/form-field", () => ({
  FormTextInput: ({
    initialValue,
    onChangeText,
    accessibilityLabel,
  }: {
    initialValue: string;
    onChangeText: (text: string) => void;
    accessibilityLabel: string;
  }) => {
    const change = React.useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(e.target.value),
      [onChangeText],
    );
    return (
      <textarea aria-label={accessibilityLabel} defaultValue={initialValue} onChange={change} />
    );
  },
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
  AdaptiveTextInput: ({
    initialValue,
    onChangeText,
    accessibilityLabel,
  }: {
    initialValue: string;
    onChangeText: (text: string) => void;
    accessibilityLabel: string;
  }) => {
    const change = React.useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(e.target.value),
      [onChangeText],
    );
    return (
      <textarea aria-label={accessibilityLabel} defaultValue={initialValue} onChange={change} />
    );
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    onPress,
    disabled,
    children,
  }: {
    onPress: () => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/action-footer", () => ({
  ActionFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const base = {
  role: "factory-builds",
  shippedCharter: "current charter",
  charterVersion: "v2",
  additions: "owner additions",
  revision: 4,
  updatedAt: null,
  history: [{ revision: 3, additions: "previous additions", updatedAt: null }],
  basedOn: { charterVersion: "v1", charterText: "old charter" },
};
beforeEach(() => {
  vi.stubGlobal("React", React);
  fixture.invoke.mockReset();
});
afterEach(cleanup);
async function mount(review: object) {
  fixture.invoke.mockResolvedValue({ ...base, review });
  act(() =>
    openFactoryInstructions({
      serverId: "host",
      projectId: "project",
      role: "factory-builds",
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FactoryInstructionsPanel />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("projectFactory.projectInstructions");
}
it("keeps a conflicting draft visible and reports the failure", async () => {
  await mount({ status: "none" });
  fixture.invoke.mockRejectedValueOnce(new Error("Someone else saved first"));
  fireEvent.change(screen.getByLabelText("projectFactory.projectInstructions"), {
    target: { value: "unsaved draft" },
  });
  fireEvent.click(screen.getByText("common.actions.save"));
  await screen.findByText(/Someone else saved first/);
  expect(
    (screen.getByLabelText("projectFactory.projectInstructions") as HTMLTextAreaElement).value,
  ).toBe("unsaved draft");
});
it("shows needed review and both charter versions", async () => {
  await mount({ status: "needed" });
  expect(screen.getByText("projectFactory.reviewNeeded")).toBeTruthy();
  expect(screen.getByText(/− old charter/)).toBeTruthy();
  expect(screen.getByText(/\+ current charter/)).toBeTruthy();
  expect(screen.queryByText("projectFactory.accept")).toBeNull();
});
it.each([true, false])("resolves proposed instructions with accept=%s", async (accept) => {
  await mount({
    status: "proposed",
    proposal: { text: "proposal", rationale: "reason", proposedAt: "now" },
  });
  expect(screen.getByText("reason")).toBeTruthy();
  fixture.invoke.mockResolvedValueOnce({
    ...base,
    revision: 5,
    review: { status: "none" },
  });
  fireEvent.click(screen.getByText(accept ? "projectFactory.accept" : "projectFactory.dismiss"));
  await waitFor(() =>
    expect(fixture.invoke).toHaveBeenLastCalledWith("factory.project.instructions.resolve", {
      projectId: "project",
      role: "factory-builds",
      expectedRevision: 4,
      accept,
    }),
  );
});

it("opens a fresh revision instead of reusing an earlier opening's cache", async () => {
  await mount({ status: "none" });
  fixture.invoke.mockResolvedValue({
    ...base,
    revision: 9,
    additions: "someone else's latest revision",
    review: { status: "none" },
  });
  act(() =>
    openFactoryInstructions({ serverId: "host", projectId: "project", role: "factory-builds" }),
  );
  await screen.findByDisplayValue("someone else's latest revision");
});
