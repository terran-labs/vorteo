/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useMakeFactoryForeman } from "./use-make-factory-foreman";
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
    return { data: { state: fixture.state, repository: null, roles: [] } };
  },
}));
vi.mock("./project-factory", () => ({ openFactoryDialog: vi.fn() }));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugins: () => [{ id: "factory", serverId: "host", invoke: fixture.invoke }],
}));
const sessionState = vi.hoisted(() => ({
  sessions: {
    host: {
      agents: new Map<string, unknown>([
        [
          "agent",
          {
            workspaceId: "workspace",
            cwd: "/repo",
            labels: { "vorteo.factory-role": "project:factory-intake" },
          },
        ],
        ["foreign-agent", { workspaceId: "foreign-workspace", cwd: "/other", labels: {} }],
      ]),
      workspaces: new Map([
        ["workspace", { projectId: "project" }],
        ["foreign-workspace", { projectId: "foreign-project" }],
      ]),
    },
  },
}));
// The real store hook's semantics: React reads the selection through useSyncExternalStore, so a
// selector that builds a new value on every call loops React, as it did in the browser (#625).
vi.mock("@/stores/session-store", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSessionStore: (select: (state: unknown) => unknown) =>
      useSyncExternalStore(
        () => () => {},
        () => select(sessionState),
      ),
  };
});
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

it("renders Make this thread the Foreman against real store semantics (#360)", () => {
  // A thread tab mounts this hook; a selector returning a fresh object crashed every chat.
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useMakeFactoryForeman("host", "workspace", "agent"), { wrapper });
  expect(hook.result.current).toBeTypeOf("function");
  hook.rerender();
  expect(hook.result.current).toBeTypeOf("function");
});
