/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useSendToFactory } from "./use-send-to-factory";
const fixture = vi.hoisted(() => ({
  state: "on",
  read: vi.fn(),
  invoke: vi.fn(),
  show: vi.fn(),
  error: vi.fn(),
}));
vi.mock("./factory-instructions", () => ({
  useProjectFactory: (...args: unknown[]) => {
    fixture.read(...args);
    return { data: { state: fixture.state } };
  },
}));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugins: () => [{ id: "factory", serverId: "host", invoke: fixture.invoke }],
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          agents: new Map([
            ["agent", { workspaceId: "workspace" }],
            ["foreign-agent", { workspaceId: "foreign-workspace" }],
          ]),
          workspaces: new Map([
            ["workspace", { projectId: "project" }],
            ["foreign-workspace", { projectId: "foreign-project" }],
          ]),
        },
      },
    }),
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: fixture.show, error: fixture.error }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  fixture.state = "on";
  fixture.read.mockClear();
  fixture.invoke.mockReset();
  fixture.show.mockReset();
  fixture.error.mockReset();
});
it.each(["off", "paused", "unavailable"])("hides Send to Factory when %s", (state) => {
  fixture.state = state;
  expect(
    renderHook(() => useSendToFactory("host", "workspace", "agent")).result.current,
  ).toBeUndefined();
});
it("sends the thread and confirms intake with a toast", async () => {
  fixture.invoke.mockResolvedValue({ queued: true });
  const hook = renderHook(() => useSendToFactory("host", "workspace", "agent"));
  await act(async () => {
    await hook.result.current?.();
  });
  expect(fixture.invoke).toHaveBeenCalledWith("factory.project.send_thread", {
    projectId: "project",
    agentId: "agent",
  });
  expect(fixture.read).toHaveBeenCalledWith("host", "project", true, { refetchInterval: false });
  expect(fixture.show).toHaveBeenCalledWith("projectFactory.sent", { variant: "success" });
});

it("routes a thread opened from another workspace to its own project", async () => {
  fixture.invoke.mockResolvedValue({ queued: true });
  const hook = renderHook(() => useSendToFactory("host", "workspace", "foreign-agent"));
  await act(async () => {
    await hook.result.current?.();
  });
  expect(fixture.invoke).toHaveBeenCalledWith("factory.project.send_thread", {
    projectId: "foreign-project",
    agentId: "foreign-agent",
  });
});
