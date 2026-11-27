import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfig,
  type ProviderUsage,
} from "@getpaseo/protocol/messages";

import { resolveDefaultLaunch } from "./launch-selection.js";

const installation = {
  installationId: "4c07b582-7d41-4be4-9725-36f975708983",
  serverId: "host",
  environment: "host" as const,
  revision: 1,
};

function settings(patch: Partial<MutableDaemonConfig> = {}): MutableDaemonConfig {
  return { ...MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }), ...patch };
}

function launchInput(
  config: MutableDaemonConfig,
  ready: string[],
  usage: ProviderUsage[] = [],
  /** Changes settings while the provider read is in flight, as an owner edit would. */
  duringRead?: (current: MutableDaemonConfig, read: number) => MutableDaemonConfig,
) {
  let current = config;
  let readings = usage;
  let reads = 0;
  return {
    current: () => current,
    set: (next: MutableDaemonConfig) => {
      current = next;
    },
    setUsage: (next: ProviderUsage[]) => {
      readings = next;
    },
    input: {
      providers: {
        listProviders: async () => {
          reads += 1;
          if (duringRead) current = duringRead(current, reads);
          return ready.map((provider) => ({ provider, enabled: true, status: "ready" as const }));
        },
      },
      readUsage: async () => ({ providers: readings }),
      getSettings: () => current,
    },
  };
}

/** A signed-in reading whose windows have these remaining percentages. */
function metered(providerId: string, ...remaining: number[]): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    windows: remaining.map((remainingPct, index) => ({
      id: `w${index}`,
      label: `Window ${index}`,
      remainingPct,
    })),
  };
}

const automaticInstallation = (patch: Partial<MutableDaemonConfig> = {}) =>
  settings({
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation,
    },
    installationPrimaryConnection: null,
    installationPrimaryConnectionSupported: true,
    installationPrimaryConnectionAutomatic: true,
    ...patch,
  });

describe("resolveDefaultLaunch", () => {
  test("launches with the installation's primary connection, not the first usable provider", async () => {
    const { input } = launchInput(
      settings({
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation,
          defaultProvider: "claude",
        },
        installationPrimaryConnection: { provider: "codex" },
        installationPrimaryConnectionSupported: true,
      }),
      ["claude", "codex"],
    );
    expect(await resolveDefaultLaunch(input)).toEqual({ provider: "codex" });
  });

  test("uses the primary connection's profile, else the provider's default profile", async () => {
    const profiled = launchInput(
      settings({
        primaryConnection: { provider: "claude", profileId: "shared-profile/claude/deep" },
      }),
      ["claude"],
    );
    expect(await resolveDefaultLaunch(profiled.input)).toEqual({
      provider: "claude",
      profileId: "shared-profile/claude/deep",
    });
    const fallback = launchInput(
      settings({
        primaryConnection: { provider: "claude" },
        agentProfiles: [
          { id: "local-default", name: "Default", provider: "claude", isDefault: true },
        ] as MutableDaemonConfig["agentProfiles"],
      }),
      ["claude"],
    );
    expect(await resolveDefaultLaunch(fallback.input)).toEqual({
      provider: "claude",
      profileId: "local-default",
    });
  });

  test("before Automatic, no primary waits; a primary that is not ready or signed out waits", async () => {
    const unset = launchInput(
      settings({
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation,
        },
        installationPrimaryConnection: null,
        installationPrimaryConnectionSupported: true,
      }),
      ["claude"],
    );
    // An older coordinator never projects the Automatic marker, so an unchosen primary waits.
    expect(await resolveDefaultLaunch(unset.input)).toBeNull();

    const notReady = launchInput(settings({ primaryConnection: { provider: "codex" } }), [
      "claude",
    ]);
    expect(await resolveDefaultLaunch(notReady.input)).toBeNull();

    const signedOut = launchInput(
      settings({ primaryConnection: { provider: "claude" } }),
      ["claude"],
      [
        {
          providerId: "claude",
          status: "unavailable",
          authRecovery: { instructions: "Sign in again." },
        } as ProviderUsage,
      ],
    );
    expect(await resolveDefaultLaunch(signedOut.input)).toBeNull();

    // A transient usage error is not a sign out: the ready primary still launches.
    const usageError = launchInput(
      settings({ primaryConnection: { provider: "claude" } }),
      ["claude"],
      [{ providerId: "claude", status: "error" } as ProviderUsage],
    );
    expect(await resolveDefaultLaunch(usageError.input)).toEqual({ provider: "claude" });

    // A setup-token connection that has never hit a limit has no reading, and still launches.
    const setupToken = launchInput(
      settings({ primaryConnection: { provider: "claude" } }),
      ["claude"],
      [{ providerId: "claude", status: "unavailable" } as ProviderUsage],
    );
    expect(await resolveDefaultLaunch(setupToken.input)).toEqual({ provider: "claude" });

    // No credentials at all: launching would only fail, so it waits like a sign out.
    const noCredentials = launchInput(
      settings({ primaryConnection: { provider: "claude" } }),
      ["claude"],
      [{ providerId: "claude", status: "unavailable", credentialsMissing: true } as ProviderUsage],
    );
    expect(await resolveDefaultLaunch(noCredentials.input)).toBeNull();
  });

  test("Automatic picks the most remaining quota, then the default provider, then order", async () => {
    const usage = [
      metered("codex", 90, 40),
      metered("codex-2", 80),
      metered("claude", 95, 80),
      metered("codex-3", 100, 0),
    ];
    const ready = ["codex", "codex-2", "claude", "codex-3", "opencode"];
    // codex-2 and claude tie at 80 remaining; codex-3 has a window with nothing left.
    const byOrder = launchInput(automaticInstallation(), ready, usage);
    expect(await resolveDefaultLaunch(byOrder.input)).toEqual({ provider: "codex-2" });
    const preferences = automaticInstallation().sharedProviderPreferences!;
    const byDefault = launchInput(
      automaticInstallation({
        sharedProviderPreferences: { ...preferences, defaultProvider: "claude" },
      }),
      ready,
      usage,
    );
    expect(await resolveDefaultLaunch(byDefault.input)).toEqual({ provider: "claude" });
    // An account without usage windows ranks after every metered one.
    const unmetered = launchInput(automaticInstallation(), ready, [
      metered("codex", 0),
      metered("codex-2", 0),
      metered("claude", 0),
      metered("codex-3", 0),
    ]);
    expect(await resolveDefaultLaunch(unmetered.input)).toEqual({ provider: "opencode" });
    // A standalone daemon that has not chosen uses Automatic too.
    const standalone = launchInput(settings(), ready, usage);
    expect(await resolveDefaultLaunch(standalone.input)).toEqual({ provider: "codex-2" });
  });

  test("Automatic keeps its pick while that account stays a candidate", async () => {
    const launch = launchInput(
      automaticInstallation(),
      ["codex", "claude"],
      [metered("codex", 70), metered("claude", 50)],
    );
    expect(await resolveDefaultLaunch(launch.input)).toEqual({ provider: "codex" });
    // Claude now has more left, but system threads do not move while Codex can still run them.
    launch.setUsage([metered("codex", 20), metered("claude", 90)]);
    expect(await resolveDefaultLaunch(launch.input)).toEqual({ provider: "codex" });
    // Codex runs out, so Automatic moves, and stays on Claude once Codex recovers.
    launch.setUsage([metered("codex", 0), metered("claude", 90)]);
    expect(await resolveDefaultLaunch(launch.input)).toEqual({ provider: "claude" });
    launch.setUsage([metered("codex", 100), metered("claude", 10)]);
    expect(await resolveDefaultLaunch(launch.input)).toEqual({ provider: "claude" });
  });

  test("Automatic never picks an account switched off for it, or one it cannot confirm", async () => {
    const providers = { codex: { automaticPrimary: false }, claude: {} };
    const launch = launchInput(
      automaticInstallation({ providers: providers as MutableDaemonConfig["providers"] }),
      ["codex", "claude", "opencode", "copilot"],
      [
        metered("codex", 100),
        { providerId: "claude", status: "error" } as ProviderUsage,
        { providerId: "opencode", status: "unavailable" } as ProviderUsage,
        {
          providerId: "copilot",
          status: "unavailable",
          authRecovery: { instructions: "Sign in again." },
        } as ProviderUsage,
      ],
    );
    expect(await resolveDefaultLaunch(launch.input)).toBeNull();
    // Switching it back on makes the same account eligible.
    launch.set(automaticInstallation());
    expect(await resolveDefaultLaunch(launch.input)).toEqual({ provider: "codex" });
  });

  test("Automatic refuses another entry that launches with a switched-off account's home", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "automatic-homes-"));
    try {
      const codexHome = path.join(root, "codex-2");
      const claudeHome = path.join(root, "claude-2");
      mkdirSync(codexHome);
      mkdirSync(claudeHome);
      // The duplicates reach the same folders through a symlink, compared by real path.
      symlinkSync(codexHome, path.join(root, "codex-link"));
      symlinkSync(claudeHome, path.join(root, "claude-link"));
      const providers = {
        "codex-2": { extends: "codex", env: { CODEX_HOME: codexHome }, automaticPrimary: false },
        "codex-copy": { extends: "codex", env: { CODEX_HOME: path.join(root, "codex-link") } },
        "claude-2": {
          extends: "claude",
          env: { CLAUDE_CONFIG_DIR: claudeHome },
          automaticPrimary: false,
        },
        "claude-copy": {
          extends: "claude",
          env: { CLAUDE_CONFIG_DIR: path.join(root, "claude-link") },
        },
        "codex-3": { extends: "codex", env: { CODEX_HOME: path.join(root, "codex-3") } },
      };
      const launch = launchInput(
        automaticInstallation({ providers: providers as MutableDaemonConfig["providers"] }),
        ["codex-copy", "claude-copy", "codex-3"],
        [metered("codex-copy", 100), metered("claude-copy", 100), metered("codex-3", 10)],
      );
      expect(await resolveDefaultLaunch(launch.input)).toEqual({ provider: "codex-3" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an explicit choice is never overridden, and an unusable one waits instead of Automatic", async () => {
    const usage = [
      metered("codex", 10),
      metered("claude", 90),
      {
        providerId: "copilot",
        status: "unavailable",
        authRecovery: { instructions: "Sign in again." },
      } as ProviderUsage,
    ];
    const chosen = launchInput(
      automaticInstallation({ installationPrimaryConnection: { provider: "codex" } }),
      ["codex", "claude", "copilot"],
      usage,
    );
    expect(await resolveDefaultLaunch(chosen.input)).toEqual({ provider: "codex" });
    const signedOut = launchInput(
      automaticInstallation({ installationPrimaryConnection: { provider: "copilot" } }),
      ["codex", "claude", "copilot"],
      usage,
    );
    expect(await resolveDefaultLaunch(signedOut.input)).toBeNull();
    const standalone = launchInput(
      settings({ primaryConnection: { provider: "copilot" } }),
      ["codex", "claude", "copilot"],
      usage,
    );
    expect(await resolveDefaultLaunch(standalone.input)).toBeNull();
  });

  test("an older coordinator keeps the first usable launch and never waits", async () => {
    // An installation daemon whose coordinator never projected the support marker.
    const legacy = launchInput(
      settings({
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation,
          defaultProvider: "codex",
        },
        installationPrimaryConnection: null,
      }),
      ["claude", "codex"],
    );
    expect(await resolveDefaultLaunch(legacy.input)).toEqual({ provider: "codex" });
    // The earlier rule skips readings that are unavailable or failed without a sign-in request.
    const unconfirmed = launchInput(
      legacy.current(),
      ["claude", "codex"],
      [
        { providerId: "codex", status: "unavailable" } as ProviderUsage,
        { providerId: "claude", status: "error" } as ProviderUsage,
      ],
    );
    expect(await resolveDefaultLaunch(unconfirmed.input)).toBeNull();
    const none = launchInput(
      settings({
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation,
        },
      }),
      [],
    );
    expect(await resolveDefaultLaunch(none.input)).toBeNull();
  });

  test("a supporting coordinator waits while unset and launches its primary once set", async () => {
    const preferences = {
      version: 1 as const,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation,
      defaultProvider: "claude",
    };
    const unset = launchInput(
      settings({
        sharedProviderPreferences: preferences,
        installationPrimaryConnection: null,
        installationPrimaryConnectionSupported: true,
      }),
      ["claude", "codex"],
    );
    expect(await resolveDefaultLaunch(unset.input)).toBeNull();
    const chosen = launchInput(
      settings({
        sharedProviderPreferences: preferences,
        installationPrimaryConnection: { provider: "codex" },
        installationPrimaryConnectionSupported: true,
      }),
      ["claude", "codex"],
    );
    expect(await resolveDefaultLaunch(chosen.input)).toEqual({ provider: "codex" });
  });

  test("a supporting coordinator, then an older one on reconnect, gives the first usable launch", async () => {
    const preferences = {
      version: 1 as const,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation,
      defaultProvider: "claude",
    };
    const launch = launchInput(
      settings({
        sharedProviderPreferences: preferences,
        installationPrimaryConnection: null,
        installationPrimaryConnectionSupported: true,
      }),
      ["claude", "codex"],
    );
    expect(await resolveDefaultLaunch(launch.input)).toBeNull();
    // The fresh admission read comes from an older coordinator and clears the marker.
    const refreshSupport = vi.fn(async () => {
      launch.set({ ...launch.current(), installationPrimaryConnectionSupported: false });
    });
    expect(await resolveDefaultLaunch({ ...launch.input, refreshSupport })).toEqual({
      provider: "claude",
    });
    expect(refreshSupport).toHaveBeenCalledTimes(1);
  });

  test("never launches an installation primary the owner cleared or replaced during the reads", async () => {
    const preferences = {
      version: 1 as const,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation,
    };
    const base = settings({
      sharedProviderPreferences: preferences,
      installationPrimaryConnection: { provider: "claude" },
      installationPrimaryConnectionSupported: true,
    });
    const cleared = launchInput(base, ["claude", "codex"], [], (current, read) =>
      read === 1 ? { ...current, installationPrimaryConnection: null } : current,
    );
    expect(await resolveDefaultLaunch(cleared.input)).toBeNull();
    const replaced = launchInput(base, ["claude", "codex"], [], (current, read) =>
      read === 1 ? { ...current, installationPrimaryConnection: { provider: "codex" } } : current,
    );
    expect(await resolveDefaultLaunch(replaced.input)).toEqual({ provider: "codex" });
  });

  test("never launches a superseded standalone primary, and waits if it keeps changing", async () => {
    const replaced = launchInput(
      settings({ primaryConnection: { provider: "claude" } }),
      ["claude", "codex"],
      [],
      (current, read) =>
        read === 1 ? { ...current, primaryConnection: { provider: "codex" } } : current,
    );
    expect(await resolveDefaultLaunch(replaced.input)).toEqual({ provider: "codex" });
    const churning = launchInput(
      settings({ primaryConnection: { provider: "claude" } }),
      ["claude", "codex"],
      [],
      (current, read) => ({
        ...current,
        primaryConnection: { provider: read % 2 ? "codex" : "claude" },
      }),
    );
    expect(await resolveDefaultLaunch(churning.input)).toBeNull();
  });
});
