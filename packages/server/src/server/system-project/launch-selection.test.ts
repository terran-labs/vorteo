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

function launchInput(config: MutableDaemonConfig, ready: string[], usage: ProviderUsage[] = []) {
  let current = config;
  const adoptPrimary = vi.fn((primary: MutableDaemonConfig["primaryConnection"]) => {
    current = { ...current, primaryConnection: primary };
  });
  return {
    adoptPrimary,
    current: () => current,
    input: {
      providers: {
        listProviders: async () =>
          ready.map((provider) => ({ provider, enabled: true, status: "ready" as const })),
      },
      readUsage: async () => ({ providers: usage }),
      getSettings: () => current,
      adoptPrimary,
    },
  };
}

describe("resolveDefaultLaunch", () => {
  test("launches with the installation's primary connection, not the first usable provider", async () => {
    const { input, adoptPrimary } = launchInput(
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
    expect(adoptPrimary).not.toHaveBeenCalled();
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

  test("never guesses: no primary, or a primary that is not ready or signed out, waits", async () => {
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
    expect(await resolveDefaultLaunch(unset.input)).toBeNull();
    expect(unset.adoptPrimary).not.toHaveBeenCalled();

    const notReady = launchInput(settings({ primaryConnection: { provider: "codex" } }), [
      "claude",
    ]);
    expect(await resolveDefaultLaunch(notReady.input)).toBeNull();

    const signedOut = launchInput(
      settings({ primaryConnection: { provider: "claude" } }),
      ["claude"],
      [{ providerId: "claude", status: "unavailable" } as ProviderUsage],
    );
    expect(await resolveDefaultLaunch(signedOut.input)).toBeNull();

    const ownerChooses = launchInput(settings({ primaryConnection: null }), ["claude"]);
    expect(await resolveDefaultLaunch(ownerChooses.input)).toBeNull();
    expect(ownerChooses.adoptPrimary).not.toHaveBeenCalled();
  });

  test("a standalone daemon adopts its only usable provider once", async () => {
    const only = launchInput(settings(), ["claude"]);
    expect(await resolveDefaultLaunch(only.input)).toEqual({ provider: "claude" });
    expect(only.adoptPrimary).toHaveBeenCalledWith({ provider: "claude" });
    expect(only.current().primaryConnection).toEqual({ provider: "claude" });

    const several = launchInput(settings(), ["claude", "codex"]);
    expect(await resolveDefaultLaunch(several.input)).toBeNull();
    expect(several.adoptPrimary).toHaveBeenCalledWith(null);
    // Decided: a later pass with one usable provider leaves the choice to the owner.
    expect(await resolveDefaultLaunch({ ...several.input })).toBeNull();
    expect(several.adoptPrimary).toHaveBeenCalledTimes(1);

    const none = launchInput(settings(), []);
    expect(await resolveDefaultLaunch(none.input)).toBeNull();
    expect(none.adoptPrimary).not.toHaveBeenCalled();
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
    expect(legacy.adoptPrimary).not.toHaveBeenCalled();
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
});
