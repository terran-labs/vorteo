/** @vitest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROJECT_FACTORY_INSTRUCTION_CONFLICTS } from "../../../../../plugins/factory/shared/project";
import {
  FactoryInstructionsPanel,
  openFactoryInstructions,
  useProjectFactories,
} from "./factory-instructions";
import { projectFactoryTargets } from "./project-factory-model";
import {
  INSTRUCTION_CONFLICT_MESSAGES,
  isInstructionsConflict,
} from "./factory-instructions-model";
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
it("refreshes a conflicting revision, preserves the draft, and saves against the latest revision", async () => {
  await mount({ status: "none" });
  fixture.invoke
    .mockRejectedValueOnce(
      new Error(`${PROJECT_FACTORY_INSTRUCTION_CONFLICTS.revision}; they are now at revision 5.`),
    )
    .mockResolvedValueOnce({
      ...base,
      additions: "their new additions",
      revision: 5,
      review: { status: "none" },
    })
    .mockResolvedValueOnce({
      ...base,
      additions: "unsaved draft",
      revision: 6,
      review: { status: "none" },
    });
  fireEvent.change(screen.getByLabelText("projectFactory.projectInstructions"), {
    target: { value: "unsaved draft" },
  });
  fireEvent.click(screen.getByText("common.actions.save"));
  await screen.findByText("projectFactory.conflict");
  expect(
    (screen.getByLabelText("projectFactory.projectInstructions") as HTMLTextAreaElement).value,
  ).toBe("unsaved draft");
  expect(screen.getByText(/− their new additions/)).toBeTruthy();
  fireEvent.click(screen.getByText("common.actions.save"));
  await waitFor(() =>
    expect(fixture.invoke).toHaveBeenLastCalledWith("factory.project.instructions.set", {
      projectId: "project",
      role: "factory-builds",
      expectedRevision: 5,
      additions: "unsaved draft",
    }),
  );
  await waitFor(() => expect(screen.queryByText("projectFactory.conflict")).toBeNull());
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
      ...(accept ? { proposedAt: "now" } : {}),
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

it("refreshes a replaced proposal before allowing another acceptance", async () => {
  await mount({
    status: "proposed",
    proposal: { text: "old proposal", rationale: "old reason", proposedAt: "old-time" },
  });
  fixture.invoke
    .mockRejectedValueOnce(
      new Error(`${PROJECT_FACTORY_INSTRUCTION_CONFLICTS.proposalReplaced}. Review it.`),
    )
    .mockResolvedValueOnce({
      ...base,
      review: {
        status: "proposed",
        proposal: { text: "new proposal", rationale: "new reason", proposedAt: "new-time" },
      },
    })
    .mockResolvedValueOnce({
      ...base,
      revision: 5,
      additions: "new proposal",
      review: { status: "none" },
    });
  fireEvent.click(screen.getByText("projectFactory.accept"));
  await screen.findByText("new reason");
  expect(
    fixture.invoke.mock.calls.filter((call) => call[0] === "factory.project.instructions.resolve"),
  ).toHaveLength(1);
  expect(fixture.invoke).toHaveBeenCalledWith("factory.project.instructions.resolve", {
    projectId: "project",
    role: "factory-builds",
    expectedRevision: 4,
    accept: true,
    proposedAt: "old-time",
  });
  fireEvent.click(screen.getByText("projectFactory.accept"));
  await waitFor(() =>
    expect(fixture.invoke).toHaveBeenLastCalledWith("factory.project.instructions.resolve", {
      projectId: "project",
      role: "factory-builds",
      expectedRevision: 4,
      accept: true,
      proposedAt: "new-time",
    }),
  );
});
it("takes role labels and order from daemon state", async () => {
  fixture.invoke.mockImplementation(async (method: string) =>
    method === "factory.project.get"
      ? {
          schemaVersion: 1,
          serverId: "host",
          projectId: "project",
          state: "on",
          repository: "owner/repo",
          reason: null,
          workers: { workerProfileId: null, reviewerProfileId: null },
          roles: [
            { role: "factory-builds", title: "Builder supplied by daemon" },
            { role: "factory-triage", title: "Intake supplied by daemon" },
          ].map((role) => ({
            role: role.role,
            title: role.title,
            workspaceId: null,
            agentId: null,
            heartbeat: null,
            launch: { provider: null, profileId: null },
            status: null,
            instructions: { revision: 0, review: "none" },
          })),
        }
      : { ...base, review: { status: "none" } },
  );
  act(() => openFactoryInstructions({ serverId: "host", projectId: "project" }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FactoryInstructionsPanel />
    </QueryClientProvider>,
  );
  await screen.findByText("Builder supplied by daemon");
  const labels = screen.getAllByRole("button").map((button) => button.textContent);
  expect(labels.indexOf("Builder supplied by daemon")).toBeLessThan(
    labels.indexOf("Intake supplied by daemon"),
  );
});

it("recognizes exactly the daemon's instruction conflict messages", () => {
  expect([...INSTRUCTION_CONFLICT_MESSAGES]).toEqual(
    Object.values(PROJECT_FACTORY_INSTRUCTION_CONFLICTS),
  );
  for (const message of Object.values(PROJECT_FACTORY_INSTRUCTION_CONFLICTS))
    expect(isInstructionsConflict(new Error(`${message}. Reload and try again.`))).toBe(true);
  expect(isInstructionsConflict(new Error("Factory is off for this project."))).toBe(false);
  expect(isInstructionsConflict(new Error("Unknown revision of the network"))).toBe(false);
});

it("reads Factory state only for projects with project-factory members, with a stable result", async () => {
  const state = {
    schemaVersion: 1,
    serverId: "host",
    projectId: "member-project",
    state: "on",
    repository: "owner/repo",
    reason: null,
    roles: [],
    workers: { workerProfileId: null, reviewerProfileId: null },
  };
  fixture.invoke.mockResolvedValue(state);
  const supported = new Map([["host", true]]);
  const entries = new Map([
    ["host:member", { factoryMembership: { installationId: "project-factory:member-project" } }],
    ["host:legacy", { factoryMembership: { installationId: "retained-controller" } }],
  ]);
  const seen: unknown[] = [];
  function Probe({ projectId, workspaceKey }: { projectId: string; workspaceKey: string }) {
    const targets = React.useMemo(
      () =>
        projectFactoryTargets(
          [{ serverId: "host", projectId }],
          [{ serverId: "host", workspaceKey }],
          entries,
        ),
      [projectId, workspaceKey],
    );
    seen.push(useProjectFactories(targets, supported));
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Probe projectId="plain-project" workspaceKey="host:plain" />
      <Probe projectId="legacy-project" workspaceKey="host:legacy" />
      <Probe projectId="member-project" workspaceKey="host:member" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(seen.at(-1)).toEqual([state]));
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
  expect(fixture.invoke).toHaveBeenCalledWith("factory.project.get", {
    projectId: "member-project",
  });

  const before = seen.at(-1);
  view.rerender(
    <QueryClientProvider client={client}>
      <Probe projectId="plain-project" workspaceKey="host:plain" />
      <Probe projectId="legacy-project" workspaceKey="host:legacy" />
      <Probe projectId="member-project" workspaceKey="host:member" />
    </QueryClientProvider>,
  );
  expect(seen.at(-1)).toBe(before);
});
