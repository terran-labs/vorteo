import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("./settings", () => ({
  requestInstallationSettings: vi.fn(),
  useInstallationSettings: () => ({ data: undefined }),
}));

import {
  canMakePrimary,
  confirmPrimaryConnection,
  isPrimaryConnection,
  primaryConnectionUpdate,
  recordPrimaryConnection,
} from "./primary-connection";
import { requestInstallationSettings } from "./settings";

const request = vi.mocked(requestInstallationSettings);

afterEach(() => request.mockReset());

describe("primary connection", () => {
  it("marks the connection whose definitions include the primary one", () => {
    const definitions = [{ id: "default-host" }, { id: "default-dev" }];
    expect(isPrimaryConnection({ providerId: "default-dev" }, definitions)).toBe(true);
    expect(isPrimaryConnection({ providerId: "codex" }, definitions)).toBe(false);
    expect(isPrimaryConnection(null, definitions)).toBe(false);
    expect(isPrimaryConnection(undefined, definitions)).toBe(false);
  });

  it("offers Make primary only on other enabled connections that are ready somewhere", () => {
    const ready = [{ kind: "attention" }, { kind: "ready" }];
    expect(canMakePrimary({ primary: false, enabled: true, states: ready })).toBe(true);
    expect(canMakePrimary({ primary: true, enabled: true, states: ready })).toBe(false);
    expect(canMakePrimary({ primary: null, enabled: true, states: ready })).toBe(false);
    expect(canMakePrimary({ primary: false, enabled: false, states: ready })).toBe(false);
    expect(canMakePrimary({ primary: false, enabled: true, states: [{ kind: "attention" }] })).toBe(
      false,
    );
  });

  it("confirms before saving and reports the result as a toast", async () => {
    const toast = { show: vi.fn(), error: vi.fn() };
    const choose = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => false);
    const input = { name: "Codex 1", providerId: "codex-def", confirm, choose, toast };
    const describeError = (failure: unknown) => String(failure);

    expect(await confirmPrimaryConnection({ ...input, describeError })).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Make Codex 1 the primary connection?",
        message: expect.stringContaining("from their next start"),
        confirmLabel: "Make primary",
      }),
    );
    expect(choose).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    expect(await confirmPrimaryConnection({ ...input, describeError })).toBe(true);
    expect(choose).toHaveBeenCalledWith({ providerId: "codex-def" });
    expect(toast.show).toHaveBeenCalledWith("Codex 1 is now the primary connection.");

    choose.mockRejectedValueOnce(new Error("Shared settings changed."));
    expect(
      await confirmPrimaryConnection({
        ...input,
        describeError: (failure) => (failure as Error).message,
      }),
    ).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Shared settings changed.");
  });

  it("records the setup guide's choice against the current revision", async () => {
    request.mockResolvedValueOnce({ revision: 7, settings: {} } as never);
    request.mockResolvedValueOnce({ revision: 8 } as never);
    await recordPrimaryConnection({
      providerId: "claude-def",
      profileId: "shared-profile/claude/a",
    });
    expect(request).toHaveBeenNthCalledWith(1);
    expect(request).toHaveBeenNthCalledWith(
      2,
      primaryConnectionUpdate(
        { revision: 7 },
        { providerId: "claude-def", profileId: "shared-profile/claude/a" },
      ),
    );
    expect(primaryConnectionUpdate({ revision: 7 }, { providerId: "claude-def" })).toEqual({
      expectedRevision: 7,
      settings: { primaryConnection: { providerId: "claude-def" } },
    });
  });

  it("refuses to record before shared settings exist", async () => {
    request.mockResolvedValueOnce({ revision: 0, settings: null } as never);
    await expect(recordPrimaryConnection({ providerId: "claude-def" })).rejects.toThrow(
      "still being set up",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
