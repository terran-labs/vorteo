/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FactoryProjectActions } from "./factory-project-actions";
import { openFactoryDialog, ProjectFactoryDialog } from "./project-factory";
const fixture = vi.hoisted(() => {
  const invoke = vi.fn();
  return {
    invoke,
    plugin: { id: "factory", serverId: "host", invoke },
    checkout: vi.fn(),
    error: vi.fn(),
    t: (key: string) => key,
  };
});
vi.mock("@/plugins/registry", () => ({ useInstalledPlugins: () => [fixture.plugin] }));
vi.mock("@/components/ui/menu", () => ({ useMenuContext: () => ({ open: true }) }));
vi.mock("./factory-instructions", () => ({ openFactoryInstructions: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({ getCheckoutStatus: fixture.checkout }) }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: fixture.error }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: fixture.t }) }));
vi.mock("./project-menu-item", () => ({
  ProjectMenuItem: ({
    children,
    disabled,
    onSelect,
  }: React.PropsWithChildren<{ disabled?: boolean; onSelect?: () => void }>) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onPress,
  }: React.PropsWithChildren<{ disabled?: boolean; onPress?: () => void }>) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    footer,
  }: React.PropsWithChildren<{ footer?: React.ReactNode }>) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("@/components/ui/action-footer", () => ({
  ActionFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("@/components/ui/form-field", () => ({
  FormTextInput: ({
    initialValue,
    onChangeText,
    accessibilityLabel,
  }: {
    initialValue: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
  }) => {
    const change = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value),
      [onChangeText],
    );
    return <input aria-label={accessibilityLabel} defaultValue={initialValue} onChange={change} />;
  },
}));
const target = { serverId: "host", projectId: "project" };
const off = {
  schemaVersion: 1,
  ...target,
  state: "off",
  repository: null,
  reason: null,
  roles: [],
  workers: { workerProfileId: null, reviewerProfileId: null },
};
beforeEach(() => {
  vi.stubGlobal("React", React);
  fixture.invoke.mockReset();
  fixture.checkout.mockReset();
});
afterEach(cleanup);
function renderActions(showDialog = false) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <FactoryProjectActions surface="dropdown" settingsTarget={target} projectPath="/project" />
      {showDialog ? <ProjectFactoryDialog /> : null}
    </QueryClientProvider>,
  );
}
it("shows a disabled loading item while reading Factory state", () => {
  fixture.invoke.mockReturnValue(new Promise(() => {}));
  renderActions();
  expect((screen.getByText("projectFactory.loading") as HTMLButtonElement).disabled).toBe(true);
  expect(fixture.invoke).toHaveBeenCalledWith("factory.project.get", { projectId: "project" });
});
it("shows a disabled error item when state cannot be read", async () => {
  fixture.invoke.mockRejectedValue(new Error("RPC unavailable"));
  renderActions();
  expect(((await screen.findByText("RPC unavailable")) as HTMLButtonElement).disabled).toBe(true);
});
it("shows the daemon's unavailable reason", async () => {
  fixture.invoke.mockResolvedValue({
    ...off,
    state: "unavailable",
    reason: "Factory requires credentials",
  });
  renderActions();
  expect(
    ((await screen.findByText("Factory requires credentials")) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByText("projectFactory.enableMenu")).toBeNull();
});
it.each(["off", "on", "paused"])("renders the %s actions", async (state) => {
  fixture.invoke.mockResolvedValue({ ...off, state });
  renderActions();
  const expected = state === "off" ? "enableMenu" : `${state === "on" ? "pause" : "resume"}Menu`;
  await screen.findByText(`projectFactory.${expected}`);
  if (state !== "off") expect(screen.getByText("projectFactory.disableMenu")).toBeTruthy();
  if (state === "paused") expect(screen.queryByText("projectFactory.pauseMenu")).toBeNull();
});
it("uses returned state after pausing", async () => {
  fixture.invoke
    .mockResolvedValueOnce({ ...off, state: "on" })
    .mockResolvedValueOnce({ ...off, state: "paused" });
  renderActions();
  fireEvent.click(await screen.findByText("projectFactory.pauseMenu"));
  await screen.findByText("projectFactory.resumeMenu");
  expect(fixture.invoke).toHaveBeenLastCalledWith("factory.project.pause", {
    projectId: "project",
  });
});
it("opens the enable dialog from the off menu action", async () => {
  fixture.invoke.mockResolvedValue(off);
  renderActions(true);
  fireEvent.click(await screen.findByText("projectFactory.enableMenu"));
  await screen.findByLabelText("projectFactory.repository");
  expect((screen.getByText("projectFactory.enable") as HTMLButtonElement).disabled).toBe(true);
});
async function renderEnable() {
  const onResult = vi.fn();
  await act(async () => {
    await openFactoryDialog({
      ...target,
      projectPath: "/project",
      repository: null,
      action: "enable",
      invoke: fixture.invoke,
      onResult,
    });
  });
  render(<ProjectFactoryDialog />);
  return onResult;
}
it("disables confirmation for empty and invalid repositories and shows validation", async () => {
  await renderEnable();
  const confirm = screen.getByText("projectFactory.enable") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("projectFactory.repository"), {
    target: { value: "invalid/repo/path" },
  });
  expect(screen.getByText("projectFactory.invalid")).toBeTruthy();
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("projectFactory.repository"), {
    target: { value: "owner/repo" },
  });
  expect(confirm.disabled).toBe(false);
});
it("prefills a GitHub remote and submits it through the plugin", async () => {
  fixture.checkout.mockResolvedValue({ remoteUrl: "git@github.com:owner/repo.git" });
  fixture.invoke.mockResolvedValue({ ...off, state: "on" });
  const onResult = await renderEnable();
  expect((screen.getByLabelText("projectFactory.repository") as HTMLInputElement).value).toBe(
    "owner/repo",
  );
  fireEvent.click(screen.getByText("projectFactory.enable"));
  await waitFor(() => expect(onResult).toHaveBeenCalled());
  expect(fixture.invoke).toHaveBeenCalledWith("factory.project.enable", {
    projectId: "project",
    repository: "owner/repo",
  });
});
it("keeps the enable dialog and repository open when the RPC fails", async () => {
  fixture.invoke.mockRejectedValue(new Error("Enable refused"));
  const onResult = await renderEnable();
  fireEvent.change(screen.getByLabelText("projectFactory.repository"), {
    target: { value: "owner/repo" },
  });
  fireEvent.click(screen.getByText("projectFactory.enable"));
  await screen.findByText("Enable refused");
  expect(onResult).not.toHaveBeenCalled();
  expect((screen.getByLabelText("projectFactory.repository") as HTMLInputElement).value).toBe(
    "owner/repo",
  );
});
