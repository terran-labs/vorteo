// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePanelOwnerAccess, type OwnerPanelSource } from "./panel-owner-access";

afterEach(cleanup);
function fakePanel() {
  let state: ReturnType<OwnerPanelSource["getState"]> = {
    initialized: false,
    unlocked: false,
    busy: false,
    error: null,
    passwordFile: "/host/owner-password",
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const model: OwnerPanelSource = {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setPassword: vi.fn(),
    clearPasswordDraft: vi.fn(() => publish({ error: null })),
    unlock: vi.fn(async () => {
      publish({ unlocked: true, error: null });
    }),
    lock: vi.fn(async () => {
      publish({ unlocked: false });
    }),
  };
  return { model, publish };
}
it("uses the same model for session restoration, unlock, lock and expiry", async () => {
  const { model, publish } = fakePanel();
  const first = renderHook(() => usePanelOwnerAccess({ model, installationPresent: true }));
  const second = renderHook(() => usePanelOwnerAccess({ model, installationPresent: true }));
  expect(first.result.current.status).toBe("checking");
  act(() => publish({ initialized: true }));
  expect(first.result.current.status).toBe("locked");
  await act(() => first.result.current.unlock("owner password"));
  expect(model.setPassword).toHaveBeenCalledWith("owner password");
  expect(model.setPassword).toHaveBeenLastCalledWith("");
  expect(model.clearPasswordDraft).not.toHaveBeenCalled();
  expect(second.result.current.status).toBe("unlocked");
  expect(first.result.current.passwordFile).toBe("/host/owner-password");
  await act(() => second.result.current.lock());
  expect(first.result.current.status).toBe("locked");
  act(() => publish({ unlocked: true }));
  act(() => publish({ unlocked: false, error: "Owner session expired" }));
  expect(second.result.current.error).toBe("Owner session expired");
  expect(second.result.current.status).toBe("locked");
});
it("reports non-installations and checking before the registry is ready", () => {
  const none = renderHook(() => usePanelOwnerAccess({ model: null, installationPresent: false }));
  const checking = renderHook(() =>
    usePanelOwnerAccess({ model: null, installationPresent: true }),
  );
  expect(none.result.current.status).toBe("none");
  expect(checking.result.current.status).toBe("checking");
});
it("publishes failed password attempts and clears the model draft", async () => {
  const { model, publish } = fakePanel();
  publish({ initialized: true });
  model.unlock = vi.fn(async () => {
    publish({ error: "Incorrect password" });
  });
  const hook = renderHook(() => usePanelOwnerAccess({ model, installationPresent: true }));
  await act(async () => {
    await expect(hook.result.current.unlock("wrong")).rejects.toThrow("Incorrect password");
  });
  expect(hook.result.current.status).toBe("locked");
  expect(hook.result.current.error).toBe("Incorrect password");
  expect(model.setPassword).toHaveBeenLastCalledWith("");
  expect(model.clearPasswordDraft).not.toHaveBeenCalled();
});

it("rejects a failed unlock even when the model has no error message", async () => {
  const { model, publish } = fakePanel();
  publish({ initialized: true });
  model.unlock = vi.fn(async () => {});
  const hook = renderHook(() => usePanelOwnerAccess({ model, installationPresent: true }));
  await act(async () => {
    await expect(hook.result.current.unlock("wrong")).rejects.toThrow("Wrong password");
  });
  expect(hook.result.current.status).toBe("locked");
  expect(model.setPassword).toHaveBeenLastCalledWith("");
});

it("reports a refused Lock to its initiating control without broadcasting password errors to badges", async () => {
  const { model, publish } = fakePanel();
  publish({ initialized: true, unlocked: true });
  model.lock = vi.fn(async () => {
    publish({ error: "Could not end owner access" });
  });
  const hook = renderHook(() => usePanelOwnerAccess({ model, installationPresent: true }));
  await act(async () => {
    await expect(hook.result.current.lock()).rejects.toThrow("Could not end owner access");
  });
  expect(hook.result.current.status).toBe("unlocked");
});
