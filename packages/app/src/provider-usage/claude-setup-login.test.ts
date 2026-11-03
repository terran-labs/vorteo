import { beforeEach, expect, test, vi } from "vitest";
import {
  claudeFullSignInAvailable,
  claudeProviderConnectsToInstallation,
  claudeSetupRequest,
  claudeUpgradeAvailable,
  claudeUpgradeRequest,
} from "./claude-setup-login";
import { requestInstallationSettings } from "@/execution-installation/settings";
import {
  InstallationRequestFailed,
  InstallationRouteUnavailable,
  OwnerAccessExpired,
  requestInstallationOwner,
} from "@/execution-installation/client";
vi.mock("@/execution-installation/settings", () => ({ requestInstallationSettings: vi.fn() }));
vi.mock("@/execution-installation/client", () => ({
  requestInstallationOwner: vi.fn(),
  InstallationRouteUnavailable: class extends Error {},
  InstallationRequestFailed: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  OwnerAccessExpired: class extends Error {},
}));
const read = vi.mocked(requestInstallationSettings);
const request = vi.mocked(requestInstallationOwner);
beforeEach(() => {
  vi.resetAllMocks();
});
function settings(definitions: unknown[]) {
  read.mockResolvedValue({ settings: { providerDefinitions: definitions } } as Awaited<
    ReturnType<typeof requestInstallationSettings>
  >);
}
const account = {
  id: "shared-one",
  providerType: "claude",
  bindings: { host: "claude-one", dev: "claude-one" },
  policy: { label: "Same label" },
};

test("Host and Dev submit the exact same installation connection without a credential payload", async () => {
  settings([
    account,
    { ...account, id: "other", bindings: { host: "claude-other", dev: "claude-other" } },
  ]);
  request.mockResolvedValue({
    status: "starting",
    attemptId: "11111111-1111-4111-8111-111111111111",
  });
  await claudeSetupRequest("host", "claude-one", "start");
  await claudeSetupRequest("dev", "claude-one", "start");
  expect(request.mock.calls).toEqual([
    ["claude/setup-token/start", "", { definitionId: "shared-one" }],
    ["claude/setup-token/start", "", { definitionId: "shared-one" }],
  ]);
});

test("missing, duplicate and removed bindings cannot silently start an environment-local login", async () => {
  for (const definitions of [
    [],
    [account, { ...account, id: "duplicate" }],
    [{ ...account, removed: true }],
  ]) {
    settings(definitions);
    await expect(claudeSetupRequest("dev", "claude-one", "start")).rejects.toThrow(
      "Refresh shared account settings",
    );
  }
  expect(request).not.toHaveBeenCalled();
});

test("unavailable coordinator is surfaced and pending delivery stays distinct from login success", async () => {
  settings([account]);
  request.mockRejectedValueOnce(new Error("Update coordinator"));
  await expect(claudeSetupRequest("host", "claude-one", "start")).rejects.toThrow(
    "Update coordinator",
  );
  request.mockResolvedValueOnce({
    login: { status: "idle" },
    connection: { connected: true, environments: [{ serverId: "dev", status: "pending" }] },
  });
  expect((await claudeSetupRequest("host", "claude-one", "read")).connection?.environments).toEqual(
    [{ serverId: "dev", status: "pending" }],
  );
});

test("full sign-in accounts use the Host refresh routes and report the Host account", async () => {
  settings([
    {
      ...account,
      accountSetup: {
        provider: "claude",
        creationId: "11111111-1111-4111-8111-111111111111",
        signIn: "full",
      },
    },
  ]);
  request.mockResolvedValueOnce({
    status: "starting",
    attemptId: "11111111-1111-4111-8111-111111111111",
  });
  await claudeSetupRequest("host", "claude-one", "start");
  expect(request.mock.calls[0]).toEqual(["claude/oauth/start", "", { definitionId: "shared-one" }]);
  request.mockResolvedValueOnce({
    login: { status: "idle" },
    connection: {
      signedIn: true,
      needsSignIn: false,
      identity: { email: "owner@example.com", orgId: null },
      expiresAt: 1,
      refresh: null,
      environments: [{ serverId: "dev", status: "ready" }],
    },
  });
  expect((await claudeSetupRequest("host", "claude-one", "read")).connection).toEqual({
    connected: true,
    needsSignIn: false,
    accountLabel: "owner@example.com",
    environments: [{ serverId: "dev", status: "ready" }],
  });
});

test("a lost Host grant reads as not connected so the owner signs in again", async () => {
  settings([
    {
      ...account,
      accountSetup: {
        provider: "claude",
        creationId: "11111111-1111-4111-8111-111111111111",
        signIn: "full",
      },
    },
  ]);
  request.mockResolvedValueOnce({
    login: { status: "idle" },
    connection: { signedIn: true, needsSignIn: true, identity: null, environments: [] },
  });
  expect((await claudeSetupRequest("host", "claude-one", "read")).connection).toMatchObject({
    connected: false,
    needsSignIn: true,
  });
});

test("full sign-in is offered only when the coordinator serves its routes", async () => {
  request.mockRejectedValueOnce(
    new InstallationRequestFailed("Claude sign-in could not complete.", 409),
  );
  await expect(claudeFullSignInAvailable()).resolves.toBe(true);
  request.mockRejectedValueOnce(new InstallationRequestFailed("Coordinator maintenance", 503));
  await expect(claudeFullSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(claudeFullSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new InstallationRouteUnavailable("unavailable"));
  await expect(claudeFullSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new OwnerAccessExpired("locked"));
  await expect(claudeFullSignInAvailable()).rejects.toThrow("locked");
});

test("only installation accounts offer the shared connection", () => {
  expect(claudeProviderConnectsToInstallation("claude-account-f7b775da")).toBe(true);
  expect(claudeProviderConnectsToInstallation("claude")).toBe(false);
});

test("a setup-token account upgrades through the coordinator's upgrade routes", async () => {
  const setupAccount = {
    ...account,
    accountSetup: { provider: "claude", creationId: "33333333-3333-4333-8333-333333333333" },
  };
  settings([setupAccount]);
  const attemptId = "11111111-1111-4111-8111-111111111111";
  request.mockResolvedValueOnce({ available: true, login: { status: "idle" } });
  await expect(claudeUpgradeAvailable("dev", "claude-one")).resolves.toBe(true);
  request.mockResolvedValueOnce({ status: "starting", attemptId });
  await expect(claudeUpgradeRequest("host", "claude-one", "start")).resolves.toEqual({
    status: "starting",
    attemptId,
  });
  request.mockResolvedValueOnce({ available: false, login: { status: "verifying", attemptId } });
  await expect(claudeUpgradeRequest("host", "claude-one", "read")).resolves.toEqual({
    status: "verifying",
    attemptId,
  });
  request.mockResolvedValueOnce({
    status: "waiting",
    attemptId,
    verificationUrl: "x",
    userCode: "",
    expiresAt: "y",
  });
  await claudeUpgradeRequest("host", "claude-one", "submit", { attemptId, code: "synthetic" });
  expect(request.mock.calls).toEqual([
    ["claude/oauth/upgrade/read", "", { definitionId: "shared-one" }],
    ["claude/oauth/upgrade/start", "", { definitionId: "shared-one" }],
    ["claude/oauth/upgrade/read", "", { definitionId: "shared-one" }],
    [
      "claude/oauth/upgrade/submit",
      "",
      { definitionId: "shared-one", attemptId, code: "synthetic" },
    ],
  ]);
});

test("the upgrade is unavailable on older coordinators and for full sign-in accounts", async () => {
  settings([account]);
  request.mockRejectedValueOnce(new InstallationRouteUnavailable("unavailable"));
  await expect(claudeUpgradeAvailable("host", "claude-one")).resolves.toBe(false);
  request.mockRejectedValueOnce(new OwnerAccessExpired("expired"));
  await expect(claudeUpgradeAvailable("host", "claude-one")).rejects.toThrow("expired");
  request.mockClear();
  settings([
    {
      ...account,
      accountSetup: {
        provider: "claude",
        creationId: "33333333-3333-4333-8333-333333333333",
        signIn: "full",
      },
    },
  ]);
  await expect(claudeUpgradeAvailable("host", "claude-one")).resolves.toBe(false);
  expect(request).not.toHaveBeenCalled();
});
