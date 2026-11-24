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
// A session store with real subscription semantics. Each build stores freshly parsed labels, as
// every agent update does, so a selection holding the labels record changes on every update.
const sessionStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const build = (title = "Foreman") => ({
    sessions: {
      host: {
        agents: new Map<string, unknown>([
          [
            "agent",
            {
              workspaceId: "workspace",
              cwd: "/repo",
              title,
              labels: { "vorteo.factory-role": "project:factory-intake", note: title },
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
  });
  let state = build();
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** An agent update that changes only its title and an unrelated label. */
    update: (title: string) => {
      state = build(title);
      for (const listener of listeners) listener();
    },
    reset: () => {
      state = build();
    },
  };
});
// The real store hook reads the selection through useSyncExternalStore, so a selector that builds
// a new value on every call loops React, as it did in the browser (#625).
vi.mock("@/stores/session-store", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSessionStore: (select: (state: unknown) => unknown) =>
      useSyncExternalStore(sessionStore.subscribe, () => select(sessionStore.get())),
  };
});
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: fixture.show, error: fixture.error }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  sessionStore.reset();
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
  // A thread tab mounts this hook: a selection rebuilt on every call crashed every chat, and one
  // holding the labels record re-rendered every tab on every agent update.
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  let renders = 0;
  const hook = renderHook(
    () => {
      renders += 1;
      return useMakeFactoryForeman("host", "workspace", "agent");
    },
    { wrapper },
  );
  expect(hook.result.current).toBeTypeOf("function");
  const settled = renders;
  act(() => sessionStore.update("Renamed"));
  expect(renders).toBe(settled);
  expect(hook.result.current).toBeTypeOf("function");
});
