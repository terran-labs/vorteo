import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

const hook = vi.hoisted(() => ({
  daemonSupports: true,
  data: undefined as object | undefined,
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => hook.daemonSupports }));
vi.mock("./policy", () => ({
  installationHostServerId: () => "host",
  readExecutionInstallation: () => ({ installationId: "installation" }),
}));
vi.mock("./settings", () => ({
  InstallationSettingsConflictError: class InstallationSettingsConflictError extends Error {},
  requestInstallationSettings: vi.fn(),
  useInstallationSettings: () => ({ data: hook.data }),
}));

import {
  canMakePrimary,
  confirmDisablePrimary,
  primaryConnectionAvailability,
  usePrimaryConnection,
  confirmPrimaryConnection,
  isPrimaryConnection,
  primaryConnectionUpdate,
  PrimaryConnectionUnavailableError,
  recordPrimaryConnection,
} from "./primary-connection";
import { InstallationSettingsConflictError, requestInstallationSettings } from "./settings";

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

  it("offers Make primary only on other enabled connections that are ready on the Host", () => {
    const ready = [{ kind: "attention" }, { kind: "ready" }];
    expect(canMakePrimary({ primary: false, enabled: true, states: ready })).toBe(true);
    expect(canMakePrimary({ primary: true, enabled: true, states: ready })).toBe(false);
    expect(canMakePrimary({ primary: null, enabled: true, states: ready })).toBe(false);
    expect(canMakePrimary({ primary: false, enabled: false, states: ready })).toBe(false);
    expect(canMakePrimary({ primary: false, enabled: true, states: [{ kind: "attention" }] })).toBe(
      false,
    );
    // Ready only in Dev: the Optimizer on the Host could never launch with it.
    const devOnly = [
      { kind: "none", environment: { kind: "host" } },
      { kind: "ready", environment: { kind: "container" } },
    ];
    expect(canMakePrimary({ primary: false, enabled: true, states: devOnly })).toBe(false);
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

  it("reads the primary connection as available only where every system thread can run it", () => {
    const definition = {
      id: "claude-def",
      providerType: "claude",
      bindings: { host: "claude-1", dev: "claude-1" } as Record<string, string>,
      policy: {},
    };
    const primary = { providerId: "claude-def" };
    const ready = [{ provider: "claude-1", status: "ready" }];
    const failing = [{ provider: "claude-1", status: "error" }];
    const read = (
      sources: { serverId: string; entries?: { provider: string; status: string }[] }[],
      overrides: {
        policy?: { enabled?: boolean };
        bindings?: Record<string, string>;
        required?: string[];
        excludedOn?: string;
        signedOut?: Map<string, Set<string>>;
      } = {},
    ) =>
      primaryConnectionAvailability({
        primary,
        definitions: [
          {
            ...definition,
            bindings: overrides.bindings ?? definition.bindings,
            policy: overrides.policy ?? {},
          },
        ],
        required: overrides.required ?? ["host"],
        exclusions: overrides.excludedOn
          ? { [overrides.excludedOn]: { providerIds: ["claude-def"] } }
          : undefined,
        sources,
        signedOut: overrides.signedOut,
      });
    const bothReady = [
      { serverId: "host", entries: ready },
      { serverId: "dev", entries: ready },
    ];
    expect(read(bothReady)).toBe("available");
    // Ready in Dev does not help the Host's Optimizer.
    expect(
      read([
        { serverId: "host", entries: failing },
        { serverId: "dev", entries: ready },
      ]),
    ).toBe("unavailable");
    expect(read(bothReady, { bindings: { dev: "claude-1" } })).toBe("unavailable");
    expect(read(bothReady, { excludedOn: "host" })).toBe("unavailable");
    expect(read(bothReady, { policy: { enabled: false } })).toBe("unavailable");
    expect(read(bothReady, { signedOut: new Map([["host", new Set(["claude-1"])]]) })).toBe(
      "unavailable",
    );
    // Dev matters once a Factory runs there, judged by Dev's own sign-in.
    const devSignedOut = new Map([["dev", new Set(["claude-1"])]]);
    expect(read(bothReady, { signedOut: devSignedOut })).toBe("available");
    expect(read(bothReady, { signedOut: devSignedOut, required: ["host", "dev"] })).toBe(
      "unavailable",
    );
    expect(read([{ serverId: "host", entries: undefined }])).toBe("unknown");
    expect(read([])).toBe("unknown");
    // Removed: nothing binds it any more.
    expect(
      primaryConnectionAvailability({
        primary,
        definitions: [{ ...definition, removed: true }],
        required: ["host"],
        sources: [{ serverId: "host", entries: ready }],
      }),
    ).toBe("unavailable");
  });

  it("warns that system threads wait before the primary connection is turned off", async () => {
    const confirm = vi.fn(async () => false);
    expect(await confirmDisablePrimary("Claude 1", confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Turn off Claude 1?",
        message: expect.stringContaining("will wait until you choose another primary connection"),
      }),
    );
  });

  it("resolves against each snapshot it writes, retrying once after a conflict", async () => {
    const first = { revision: 7, settings: {} };
    const second = { revision: 9, settings: {} };
    request
      .mockResolvedValueOnce(first as never)
      .mockRejectedValueOnce(new InstallationSettingsConflictError())
      .mockResolvedValueOnce(second as never)
      .mockResolvedValueOnce({ revision: 10 } as never);
    const resolve = vi.fn((snapshot: { revision: number }) => ({
      providerId: `claude-${snapshot.revision}`,
    }));
    await recordPrimaryConnection(resolve as never);
    expect(resolve.mock.calls.map(([snapshot]) => snapshot)).toEqual([first, second]);
    expect(request).toHaveBeenNthCalledWith(
      2,
      primaryConnectionUpdate(first, { providerId: "claude-7" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      primaryConnectionUpdate(second, { providerId: "claude-9" }),
    );

    // A second conflict is the owner's to review.
    request.mockReset();
    request
      .mockResolvedValueOnce(first as never)
      .mockRejectedValueOnce(new InstallationSettingsConflictError())
      .mockResolvedValueOnce(second as never)
      .mockRejectedValueOnce(new InstallationSettingsConflictError());
    await expect(recordPrimaryConnection(resolve as never)).rejects.toBeInstanceOf(
      InstallationSettingsConflictError,
    );
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("writes nothing when the resolver finds no usable connection", async () => {
    request.mockResolvedValueOnce({ revision: 7, settings: {} } as never);
    await expect(recordPrimaryConnection(() => null)).rejects.toBeInstanceOf(
      PrimaryConnectionUnavailableError,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("passes the server's refusal through as the typed error without retrying", async () => {
    request
      .mockResolvedValueOnce({ revision: 7, settings: {} } as never)
      .mockRejectedValueOnce(new PrimaryConnectionUnavailableError());
    await expect(recordPrimaryConnection({ providerId: "removed" })).rejects.toThrow(
      "That connection is no longer available.",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("offers nothing unless both the Host daemon and the coordinator support the setting", () => {
    let seen: ReturnType<typeof usePrimaryConnection> | null = null;
    function Probe() {
      seen = usePrimaryConnection();
      return null;
    }
    const read = () => {
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <Probe />
        </QueryClientProvider>,
      );
      return seen!;
    };
    // An older coordinator never sends the key, so the badge, Make primary and Status rows hide.
    hook.data = { revision: 4, settings: { providerDefinitions: [] } };
    expect(read()).toMatchObject({ supported: false, loaded: false });
    // A supporting coordinator sends null while nothing is chosen.
    hook.data = { revision: 4, settings: { providerDefinitions: [], primaryConnection: null } };
    expect(read()).toMatchObject({ supported: true, loaded: true, primary: null });
    // An older Host daemon hides it too.
    hook.daemonSupports = false;
    expect(read()).toMatchObject({ supported: false, loaded: false });
    hook.daemonSupports = true;
  });
});
