import { describe, expect, it, vi } from "vitest";
import { requireClaudeAuthentication } from "./authentication.js";

describe("Claude authentication monitoring", () => {
  it("checks a managed grant without launching Claude, while unexpired", async () => {
    const run = vi.fn();
    const readGrant = vi.fn(async () => ({
      accessToken: "synthetic-access",
      hasRefreshToken: true,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    }));
    for (let check = 0; check < 3; check += 1) {
      await requireClaudeAuthentication({
        executable: "claude",
        args: [],
        runtimeSettings: {
          env: { CLAUDE_CONFIG_DIR: "/managed-account", VORTEO_CLAUDE_SIGN_IN: "full" },
        },
        readGrant,
        run,
      });
    }
    expect(readGrant).toHaveBeenCalledWith("/managed-account");
    expect(run).not.toHaveBeenCalled();
  });

  it("distinguishes a missing managed grant from unreadable storage without exposing errors", async () => {
    const input = {
      executable: "claude",
      args: [],
      runtimeSettings: {
        env: { CLAUDE_CONFIG_DIR: "/managed-account", VORTEO_CLAUDE_SIGN_IN: "full" },
      },
      run: vi.fn(),
      recoverGrant: async () => {},
    };
    await expect(
      requireClaudeAuthentication({ ...input, readGrant: async () => null }),
    ).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
    await expect(
      requireClaudeAuthentication({
        ...input,
        readGrant: async () => {
          throw new Error("private storage detail");
        },
      }),
    ).rejects.toMatchObject({ code: "CHECK_FAILED" });
    expect(input.run).not.toHaveBeenCalled();
  });
  it("uses the configured CLI, environment and cancellation signal", async () => {
    const signal = new AbortController().signal;
    await requireClaudeAuthentication({
      executable: "/configured/claude",
      args: ["--settings", "/account/settings.json"],
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/account" } },
      signal,
      async run(command, args, options) {
        expect(command).toBe("/configured/claude");
        expect(args).toEqual(["--settings", "/account/settings.json", "auth", "status"]);
        expect(options).toMatchObject({
          envOverlay: { CLAUDE_CONFIG_DIR: "/account" },
          timeout: 15_000,
          signal,
        });
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }), stderr: "" };
      },
    });
  });

  it("retries a timed-out check once, then fails without retrying further or after cancellation", async () => {
    const timedOut = () =>
      Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
    const signedIn = { stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
    let calls = 0;
    await requireClaudeAuthentication({
      executable: "claude",
      args: [],
      async run() {
        calls += 1;
        if (calls === 1) throw timedOut();
        return signedIn;
      },
    });
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        async run() {
          calls += 1;
          throw timedOut();
        },
      }),
    ).rejects.toMatchObject({ code: "CHECK_FAILED" });
    expect(calls).toBe(2);

    calls = 0;
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        signal: cancelled.signal,
        async run() {
          calls += 1;
          throw timedOut();
        },
      }),
    ).rejects.toMatchObject({ code: "CHECK_FAILED" });
    expect(calls).toBe(1);
  });

  it.each([0, 1])("rejects a signed-out CLI with exit status %s", async (code) => {
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        async run() {
          const stdout = JSON.stringify({ loggedIn: false });
          if (code === 1) throw Object.assign(new Error("signed out"), { code, stdout });
          return { stdout, stderr: "" };
        },
      }),
    ).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
  });

  it.each(["", "not JSON", "{}", '{"loggedIn":"true"}'])(
    "does not infer authentication from %j",
    async (stdout) => {
      await expect(
        requireClaudeAuthentication({
          executable: "claude",
          args: [],
          async run() {
            return { stdout, stderr: "" };
          },
        }),
      ).rejects.toMatchObject({ code: "CHECK_FAILED" });
    },
  );

  it("does not expose command output or report success when the check fails", async () => {
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        async run() {
          throw new Error("timeout containing private command output");
        },
      }),
    ).rejects.toMatchObject({
      code: "CHECK_FAILED",
      message:
        "Could not verify Claude authentication. Check the connection in Providers settings, then refresh the provider.",
    });
  });

  it("rejects a failed command even if its output claims to be logged in", async () => {
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        async run() {
          throw Object.assign(new Error("failed"), { code: 1, stdout: '{"loggedIn":true}' });
        },
      }),
    ).rejects.toMatchObject({ code: "CHECK_FAILED" });
  });
});

it.each([true, false])(
  "coalesces expired grant recovery and validates the reread: %s",
  async (success) => {
    let expiresAt = 1;
    let release: (() => void) | undefined;
    const recoverGrant = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (success) expiresAt = 200;
      else throw new Error("private transport detail");
    });
    const input = {
      executable: "/not-executed",
      args: [],
      runtimeSettings: {
        env: { CLAUDE_CONFIG_DIR: "/fake-account", VORTEO_CLAUDE_SIGN_IN: "full" },
      },
      now: () => 100,
      // An access-only copy: a grant with its refresh token starts the CLI without recovery.
      readGrant: async () => ({
        accessToken: "synthetic",
        hasRefreshToken: false,
        expiresAt,
        scopes: [],
      }),
      recoverGrant,
    };
    const checks = Promise.allSettled([
      requireClaudeAuthentication(input),
      requireClaudeAuthentication(input),
    ]);
    await vi.waitFor(() => expect(recoverGrant).toHaveBeenCalledTimes(1));
    release!();
    const results = await checks;
    if (success)
      expect(results).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
    else
      expect(results).toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "SIGN_IN_REQUIRED" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "SIGN_IN_REQUIRED" }),
        }),
      ]);
  },
);

it("recovers a missing local grant once and rereads it before accepting authentication", async () => {
  const recovered = {
    accessToken: "synthetic-recovered",
    hasRefreshToken: false,
    expiresAt: 200,
    scopes: [],
  };
  const readGrant = vi
    .fn<NonNullable<Parameters<typeof requireClaudeAuthentication>[0]["readGrant"]>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(recovered);
  const recoverGrant = vi.fn(async () => {});
  await requireClaudeAuthentication({
    executable: "/not-executed",
    args: [],
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/fake-account", VORTEO_CLAUDE_SIGN_IN: "full" } },
    now: () => 100,
    readGrant,
    recoverGrant,
  });
  expect(recoverGrant).toHaveBeenCalledExactlyOnceWith("/fake-account");
  expect(readGrant).toHaveBeenCalledTimes(2);
});

it("lets an expired grant that keeps its refresh token start the CLI, but not an access-only copy", async () => {
  const input = {
    executable: "/not-executed",
    args: [],
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/fake-account", VORTEO_CLAUDE_SIGN_IN: "full" } },
    now: () => 1_000,
  };
  const expired = (hasRefreshToken: boolean) =>
    vi.fn(async () => ({ accessToken: "synthetic", hasRefreshToken, expiresAt: 500, scopes: [] }));
  // The CLI refreshes a renewable grant itself; asking the coordinator first deadlocked it.
  const recoverGrant = vi.fn(async () => {});
  await requireClaudeAuthentication({ ...input, readGrant: expired(true), recoverGrant });
  expect(recoverGrant).not.toHaveBeenCalled();
  await expect(
    requireClaudeAuthentication({ ...input, readGrant: expired(false), recoverGrant }),
  ).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
  expect(recoverGrant).toHaveBeenCalledExactlyOnceWith("/fake-account");
});
