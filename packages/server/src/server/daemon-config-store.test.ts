import { editPersistedConfig, readPersistedConfig } from "./persisted-config.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { z } from "zod";

import {
  DaemonConfigStore,
  applyMutableProviderConfigToOverrides,
  OriginAdmissionUnavailableError,
} from "./daemon-config-store.js";

import { loadConfig } from "./config.js";

import { loadPersistedConfig, PersistedConfig } from "./persisted-config.js";

import { readSpeechSettings } from "./speech/speech-settings.js";

import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

function usageEnabled(persisted: PersistedConfig): boolean {
  return persisted.daemon?.usage?.enabled !== false;
}

function reloadableConfig(
  persisted: PersistedConfig,
  options: { relayEnabledFallback?: boolean } = {},
): MutableDaemonConfig {
  const daemon = persisted.daemon ?? {};
  const relay = daemon.relay ?? {};
  const git = daemon.git ?? {};
  const agents = persisted.agents ?? {};
  return {
    relay: {
      enabled: relay.enabled ?? options.relayEnabledFallback ?? true,
    },
    mcp: { enabled: true, injectIntoAgents: false },
    usage: { enabled: usageEnabled(persisted) },
    browserTools: { enabled: daemon.browserTools?.enabled ?? false },
    providers: (agents.providers ?? {}) as MutableDaemonConfig["providers"],
    metadataGeneration: { providers: agents.metadataGeneration?.providers ?? [] },
    autoArchiveAfterMerge: daemon.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: daemon.enableTerminalAgentHooks ?? false,
    idleRuntimeCleanup: agents.idleRuntimeCleanup !== false,
    appendSystemPrompt: daemon.appendSystemPrompt ?? "",
    terminalProfiles: daemon.terminalProfiles,
    agentProfiles: daemon.agentProfiles,
    cors: { allowedOrigins: [] },
    trustedProxies: ["loopback"],
    git: {
      maxProcessesPerSecond: git.maxProcessesPerSecond ?? 64,
      maxProcessConcurrency: git.maxProcessConcurrency ?? 8,
    },
    app: { baseUrl: "https://app.paseo.sh" },
    pluginsEnabled: persisted.pluginsEnabled ?? false,
    plugins: persisted.plugins ?? {},
  };
}

describe("applyMutableProviderConfigToOverrides", () => {
  test("merges mutable provider fields onto provider overrides", () => {
    expect(
      applyMutableProviderConfigToOverrides(
        {
          gemini: {
            extends: "acp",
            label: "Gemini",
            command: ["gemini", "--acp"],
          },
        },
        {
          gemini: {
            enabled: false,
            description: "Gemini ACP",
            env: { GEMINI_AUTO_UPDATE: "0" },
          },
          claude: {
            additionalModels: [
              {
                id: "claude-custom",
                label: "claude-custom",
              },
            ],
          },
        },
      ),
    ).toEqual({
      gemini: {
        extends: "acp",
        label: "Gemini",
        description: "Gemini ACP",
        command: ["gemini", "--acp"],
        env: { GEMINI_AUTO_UPDATE: "0" },
        enabled: false,
      },
      claude: {
        additionalModels: [
          {
            id: "claude-custom",
            label: "claude-custom",
          },
        ],
      },
    });
  });
});

describe("DaemonConfigStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patch persists relay state and emits its field change", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    const changes: unknown[] = [];
    store.onFieldChange("relay.enabled", (value) => changes.push(value));

    await store.patch({ relay: { enabled: true } });

    expect(changes).toEqual([true]);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(true);
    const profile = {
      id: "review",
      name: "Review",
      provider: "codex",
      isDefault: true,
      instructions: "Review all diffs",
      workerProfileId: "local",
      quotaReservePolicy: { kind: "protected" as const, cruisePct: 15, redlinePct: 10 },
    };
    store.patch({ agentProfiles: [profile], expectedAgentProfiles: [] });
    expect(() => store.patch({ agentProfiles: [], expectedAgentProfiles: [] })).toThrow(
      "another device",
    );
    store.patch({ agentProfiles: [{ id: "review", name: "Renamed", provider: "codex" }] });
    expect(store.get().agentProfiles?.[0]).toMatchObject({
      isDefault: true,
      instructions: profile.instructions,
      workerProfileId: "local",
      quotaReservePolicy: profile.quotaReservePolicy,
    });
    store.patch({ agentProfiles: [{ ...profile, instructions: "", workerProfileId: "" }] });
    expect(store.get().agentProfiles?.[0].instructions).toBe("");
    store.patch({ agentProfiles: [{ ...profile, isDefault: false }] });
    expect(store.get().agentProfiles?.[0].isDefault).toBe(false);
    expect(() =>
      store.patch({
        agentProfiles: [
          { ...profile, quotaReservePolicy: { kind: "protected", cruisePct: 10, redlinePct: 15 } },
        ],
      }),
    ).toThrow("Redline must be lower");
    store.patch({ agentProfiles: [{ ...profile, quotaReservePolicy: { kind: "off" } }] });
    expect(store.get().agentProfiles?.[0].quotaReservePolicy).toEqual({ kind: "off" });
  });

  test("patch persists the relay protected security requirement independently of relay enablement", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      // A launch override owns relay.enabled; the security requirement is still editable.
      { relayEnabledMutable: false },
    );
    const changes: unknown[] = [];
    store.onFieldChange("relay.requireProtectedSecurity", (value) => changes.push(value));

    await store.patch({ relay: { requireProtectedSecurity: true } });

    expect(changes).toEqual([true]);
    expect(store.get().relay).toEqual({ enabled: true, requireProtectedSecurity: true });
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.requireProtectedSecurity).toBe(true);
  });

  test("patch round-trips agent profiles through the strictly-parsed persisted config", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    await store.patch({
      agentProfiles: [
        {
          id: "profile_ui",
          name: "UI work",
          icon: "🎨",
          provider: "claude",
          model: "claude-opus-5",
          modeId: "plan",
          thinkingOptionId: "think-hard",
          featureValues: { webSearch: true },
          notes: "Use for components, layout and design tokens.",
        },
      ],
    });

    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toEqual([
      {
        id: "profile_ui",
        name: "UI work",
        icon: "🎨",
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
        thinkingOptionId: "think-hard",
        featureValues: { webSearch: true },
        notes: "Use for components, layout and design tokens.",
      },
    ]);
    expect(store.get().agentProfiles).toHaveLength(1);
  });

  test("patch replaces the whole agent profile list rather than merging entries", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      agentProfiles: [
        { id: "a", name: "Keep", provider: "claude" },
        { id: "b", name: "Drop", provider: "codex" },
      ],
    });

    await store.patch({ agentProfiles: [{ id: "a", name: "Keep", provider: "claude" }] });

    expect(store.get().agentProfiles).toEqual([{ id: "a", name: "Keep", provider: "claude" }]);
    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toHaveLength(1);
  });

  test("rolls back config when a field transition fails", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    function competingEdit() {
      editPersistedConfig(paseoHome, "daemon.listen", { value: "127.0.0.1:9999" });
    }
    const cause = new Error("Relay transport failed to start");
    store.onFieldChange("relay.enabled", (enabled) => {
      if (enabled === true) {
        expect(competingEdit).toThrow("busy");
        throw cause;
      }
    });

    const failure = captureConfigFailure(() => store.patch({ relay: { enabled: true } }));
    expect(failure).toBeInstanceOf(ConfigWriterError);
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true, cause });
    expect(store.get().relay?.enabled).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("rolls back live owners when a later transactional owner fails", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    let browserToolsEnabled = false;
    store.onApply((next, previous) => {
      browserToolsEnabled = next.browserTools.enabled;
      return () => {
        browserToolsEnabled = previous.browserTools.enabled;
      };
    });
    const cause = new Error("Provider refresh failed");
    store.onApply(() => {
      throw cause;
    });

    const failure = captureConfigFailure(() => store.patch({ browserTools: { enabled: true } }));
    expect(failure).toBeInstanceOf(ConfigWriterError);
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true, cause });
    expect(browserToolsEnabled).toBe(false);
    expect(store.get().browserTools.enabled).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.browserTools?.enabled).toBeUndefined();
  });

  test("rejects relay patches when a launch override owns the setting", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: false },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    expect(() => store.patch({ relay: { enabled: true } })).toThrow(
      "Relay is controlled by a daemon launch override",
    );
  });

  test("unrelated patches do not persist a one-launch relay override", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const persisted = loadPersistedConfig(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        ...persisted,
        daemon: { ...persisted.daemon, relay: { enabled: false } },
      })}\n`,
    );
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    await store.patch({ browserTools: { enabled: true } });

    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("unrelated patches persist only requested file intent", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const before = loadPersistedConfig(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { enabled: false, injectIntoAgents: false },
        hostnames: ["launch.example.test"],
        cors: { allowedOrigins: ["https://launch.example.test"] },
        trustedProxies: true,
        git: { maxProcessesPerSecond: 7, maxProcessConcurrency: 2 },
        app: { baseUrl: "https://launch.example.test" },
        catalogRefreshTimeoutMs: 9_000,
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    await store.patch({
      appendSystemPrompt: "Only this field",
      // Reload-only runtime state is accepted as unknown wire data for forward
      // compatibility but is not part of the patch capability.
      hostnames: ["attempted-patch.example.test"],
    } as Parameters<typeof store.patch>[0]);

    expect(store.get().hostnames).toEqual(["launch.example.test"]);
    expect(loadPersistedConfig(paseoHome)).toEqual({
      ...before,
      daemon: { ...before.daemon, appendSystemPrompt: "Only this field" },
    });
  });

  test("patch persists provider enabled flags into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const initial = loadPersistedConfig(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    // Reuse the validated serializer through the store path by seeding the file directly.
    // This keeps the test focused on the merge behavior.
    const seeded =
      JSON.stringify(
        {
          ...initial,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(configPath, seeded);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      providers: {
        gemini: { enabled: false },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toEqual({
      extends: "acp",
      label: "Gemini",
      command: ["gemini", "--acp"],
      enabled: false,
    });
  });

  test("patch persists provider Paseo-tool policy without changing availability", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ agents: { providers: { claude: { enabled: false } } } }),
    );
    const store = new DaemonConfigStore(paseoHome, {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: { claude: { enabled: false } },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    await store.patch({
      providers: {
        claude: {
          paseoTools: { enabled: true, disabledTools: ["list_agents"] },
        },
      },
    });
    await store.patch({
      providers: {
        claude: {
          paseoTools: { disabledTools: ["create_agent"] },
        },
      },
    });

    expect(store.get().providers.claude).toEqual({
      enabled: false,
      paseoTools: { enabled: true, disabledTools: ["create_agent"] },
    });
    expect(loadPersistedConfig(paseoHome).agents?.providers?.claude).toEqual({
      enabled: false,
      paseoTools: { enabled: true, disabledTools: ["create_agent"] },
    });
  });

  test("patch removes provider entries from config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = await store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    expect(next.providers.claude).toEqual({ enabled: false });
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toBeUndefined();
    expect(persisted.agents?.providers?.claude).toEqual({ enabled: false });
  });

  test("patch removes the providers object when the last provider is deleted", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: { gemini: {} },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({ removeProviders: ["gemini"] });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
  });

  test("patch removes deleted providers from metadata generation", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
            metadataGeneration: {
              providers: [
                { provider: "gemini", model: "flash" },
                { provider: "claude", model: "haiku" },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: {
          providers: [
            { provider: "gemini", model: "flash" },
            { provider: "claude", model: "haiku" },
          ],
        },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = await store.patch({ removeProviders: ["gemini"] });

    expect(next.metadataGeneration.providers).toEqual([{ provider: "claude", model: "haiku" }]);
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
    });
  });

  test("patch persists provider removal when in-memory config is already clean", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
            metadataGeneration: {
              providers: [{ provider: "gemini", model: "flash" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = await store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists append system prompt into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists browser tools opt-in into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({ browserTools: { enabled: true } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.browserTools).toEqual({ enabled: true });
  });

  test("patch persists provider additional models into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      providers: {
        claude: {
          additionalModels: [
            {
              id: "claude-custom",
              label: "claude-custom",
            },
          ],
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.claude).toEqual({
      additionalModels: [
        {
          id: "claude-custom",
          label: "claude-custom",
        },
      ],
    });
  });

  test("patch persists daemon append system prompt into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists enable terminal agent hooks into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({ enableTerminalAgentHooks: true });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.enableTerminalAgentHooks).toBe(true);
  });

  test("patch persists metadata generation providers into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      metadataGeneration: {
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
        ],
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("patch persists clearing metadata generation providers into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            metadataGeneration: {
              providers: [{ provider: "claude", model: "haiku" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
      },
      undefined,
    );

    await store.patch({ metadataGeneration: { providers: [] } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists the host idle runtime cleanup opt-out for the next daemon start", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        version: 1,
        agents: { metadataGeneration: { providers: [{ provider: "claude" }] } },
      })}\n`,
    );
    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        idleRuntimeCleanup: true,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude" }] },
      },
      undefined,
    );

    expect((await store.patch({ idleRuntimeCleanup: false })).idleRuntimeCleanup).toBe(false);

    expect(loadPersistedConfig(paseoHome).agents).toEqual({
      metadataGeneration: { providers: [{ provider: "claude" }] },
      idleRuntimeCleanup: false,
    });
    expect(loadConfig(paseoHome, { env: {} }).idleRuntimeCleanup).toBe(false);

    await store.patch({ idleRuntimeCleanup: true });
    expect(loadConfig(paseoHome, { env: {} }).idleRuntimeCleanup).toBe(true);
    await store.patch({ resumeOnStartup: false, resumePrompt: "Keep going.\n" });
    expect(loadPersistedConfig(paseoHome).agents).toMatchObject({
      resumeOnStartup: false,
      resumePrompt: "Keep going.\n",
    });
    expect(loadConfig(paseoHome, { env: {} })).toMatchObject({
      resumeOnStartup: false,
      resumePrompt: "Keep going.\n",
    });
  });

  test("patch persists custom ACP provider overrides into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [] },
      },
      undefined,
    );

    await store.patch({
      providers: {
        "paseo-e2e-acp": {
          extends: "acp",
          label: "Paseo E2E ACP",
          description: "E2E ACP provider fixture",
          command: ["npx", "-y", "--version"],
          env: {},
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.["paseo-e2e-acp"]).toEqual({
      extends: "acp",
      label: "Paseo E2E ACP",
      description: "E2E ACP provider fixture",
      command: ["npx", "-y", "--version"],
      env: {},
    });
  });

  test("origin inspection returns detached coherent lists without applying pending disk state", () => {
    const fixture = originFixture({
      disk: ["https://disk.example"],
      active: ["https://active.example"],
    });
    const observation = fixture.store.inspectOriginAdmission();
    expect(observation).toEqual({
      state: "ready",
      reason: null,
      persistedOrigins: ["https://disk.example"],
      activeOrigins: ["https://active.example"],
    });
    observation.persistedOrigins.push("https://caller.example");
    observation.activeOrigins?.push("https://caller.example");
    expect(readPersistedConfig(fixture.home).daemon?.cors?.allowedOrigins).toEqual([
      "https://disk.example",
    ]);
    expect(fixture.store.get().cors?.allowedOrigins).toEqual(["https://active.example"]);
    fixture.removeOwner();
    expect(fixture.store.hasOriginAdmissionOwner()).toBe(false);
    expect(fixture.store.inspectOriginAdmission()).toMatchObject({
      state: "unavailable",
      activeOrigins: ["https://active.example"],
    });
  });

  test("origin admission preserves independent active and persisted settings", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-origin-admission-"));
    tempDirs.push(home);
    const persisted: PersistedConfig = {
      version: 1,
      daemon: {
        cors: { allowedOrigins: ["https://disk.example"] },
        appendSystemPrompt: "pending disk setting",
      },
    };
    writeFileSync(path.join(home, "config.json"), JSON.stringify(persisted));
    const initial = reloadableConfig(persisted);
    initial.cors.allowedOrigins = ["https://active.example"];
    initial.appendSystemPrompt = "active setting";
    const store = new DaemonConfigStore(home, initial, undefined, {
      reloadSource: {
        resolve: (config) => ({ mutable: reloadableConfig(config), overrideControlledPaths: [] }),
      },
    });
    let origins = [...initial.cors.allowedOrigins];
    store.onFieldChange("cors.allowedOrigins", (value) => {
      origins = z.array(z.string()).parse(value);
    });
    const result = store.admitOrigin({
      origin: "https://preview.example:32785",
      expectedPersistedOrigins: ["https://disk.example"],
      expectedActiveOrigins: ["https://active.example"],
    });
    expect(result).toEqual({
      addedToPersisted: true,
      addedToActive: true,
      persistedOrigins: ["https://disk.example", "https://preview.example:32785"],
      activeOrigins: ["https://active.example", "https://preview.example:32785"],
    });
    expect(origins).toEqual(result.activeOrigins);
    expect(store.get().appendSystemPrompt).toBe("active setting");
    expect(readPersistedConfig(home).daemon?.appendSystemPrompt).toBe("pending disk setting");
  });

  function originFixture(options: { disk?: string[]; active?: string[]; override?: boolean } = {}) {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-origin-admission-"));
    tempDirs.push(home);
    const persisted: PersistedConfig = { daemon: { cors: { allowedOrigins: options.disk ?? [] } } };
    writeFileSync(path.join(home, "config.json"), JSON.stringify(persisted));
    const initial = reloadableConfig(persisted);
    initial.cors.allowedOrigins = options.active ?? [];
    const store = new DaemonConfigStore(home, initial, undefined, {
      reloadSource: {
        resolve: (config) => ({
          mutable: reloadableConfig(config),
          overrideControlledPaths: options.override ? ["daemon.cors.allowedOrigins"] : [],
        }),
      },
    });
    const removeOwner = store.onFieldChange("cors.allowedOrigins", () => {});
    const input = {
      origin: "https://preview.example:32785",
      expectedPersistedOrigins: [...(options.disk ?? [])],
      expectedActiveOrigins: [...(options.active ?? [])],
    };
    return { home, store, input, removeOwner };
  }

  test.each([
    { disk: true, active: false },
    { disk: false, active: true },
    { disk: true, active: true },
  ])("origin admission distinguishes existing sides: %j", ({ disk, active }) => {
    const origin = "https://preview.example:32785";
    const fixture = originFixture({ disk: disk ? [origin] : [], active: active ? [origin] : [] });
    const result = fixture.store.admitOrigin(fixture.input);
    expect(result.addedToPersisted).toBe(!disk);
    expect(result.addedToActive).toBe(!active);
    expect(result.persistedOrigins).toEqual([origin]);
    expect(result.activeOrigins).toEqual([origin]);
    result.activeOrigins.push("https://caller.example");
    expect(fixture.store.get().cors.allowedOrigins).toEqual([origin]);
  });

  test.each([
    "https://user:secret@example.com",
    "https://example.com/",
    "https://example.com?x=1",
    "https://example.com#x",
    "ftp://example.com",
    " https://example.com",
  ])("origin admission rejects noncanonical origin %s", (origin) => {
    const { store, input, home } = originFixture();
    expect(() => store.admitOrigin({ ...input, origin })).toThrow();
    expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).toEqual([]);
    expect(store.get().cors.allowedOrigins).toEqual([]);
  });

  test.each(["disk", "active"])("origin admission refuses changed %s preconditions", (side) => {
    const { store, input, home } = originFixture();
    if (side === "disk")
      editPersistedConfig(home, "daemon.cors.allowedOrigins", { value: ["https://other.example"] });
    else store.get().cors.allowedOrigins.push("https://other.example");
    const failure = captureConfigFailure(() => store.admitOrigin(input));
    expect(failure).toMatchObject({ code: "stale_input", writeAttempted: false });
    expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).not.toContain(input.origin);
  });

  test("origin admission requires the active owner and rejects launch overrides", () => {
    const unowned = originFixture();
    unowned.removeOwner();
    expect(() => unowned.store.admitOrigin(unowned.input)).toThrow(OriginAdmissionUnavailableError);
    const overridden = originFixture({ override: true });
    expect(() => overridden.store.admitOrigin(overridden.input)).toThrow(
      OriginAdmissionUnavailableError,
    );
  });

  test("origin admission keeps persisted uncertainty after a field owner rejects", () => {
    const { store, input, home } = originFixture();
    const cause = new Error("field owner failed");
    store.onFieldChange("cors.allowedOrigins", (value) => {
      if (Array.isArray(value) && value.includes(input.origin)) throw cause;
    });
    const failure = captureConfigFailure(() => store.admitOrigin(input));
    expect(failure).toBeInstanceOf(ConfigWriterError);
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true, cause });
    expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).toEqual([input.origin]);
    expect(store.get().cors.allowedOrigins).toEqual([]);
  });

  test("origin admission reports active-only failure without claiming a disk write", () => {
    const origin = "https://preview.example:32785";
    const { store, input, home } = originFixture({ disk: [origin] });
    const cause = new Error("active owner refused");
    store.onFieldChange("cors.allowedOrigins", (value) => {
      if (Array.isArray(value) && value.includes(origin)) throw cause;
    });
    const failure = captureConfigFailure(() => store.admitOrigin(input));
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: false, cause });
    expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).toEqual([origin]);
    expect(store.get().cors.allowedOrigins).toEqual([]);
  });

  test("origin admission excludes a competing supported editor during live apply", () => {
    const { store, input, home } = originFixture();
    let rejected: unknown;
    store.onFieldChange("cors.allowedOrigins", () => {
      try {
        editPersistedConfig(home, "daemon.appendSystemPrompt", { value: "competing" });
      } catch (error) {
        rejected = error;
      }
    });
    store.admitOrigin(input);
    expect(rejected).toMatchObject({ code: "busy", writeAttempted: false });
    expect(readPersistedConfig(home).daemon?.appendSystemPrompt).toBeUndefined();
  });

  test("origin admission detects an unfenced disk edit after persist without rollback", () => {
    const { store, input, home } = originFixture();
    store.onFieldChange("cors.allowedOrigins", () => {
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ daemon: { appendSystemPrompt: "unfenced" } }),
      );
    });
    const failure = captureConfigFailure(() => store.admitOrigin(input));
    expect(failure).toMatchObject({
      code: "uncertain",
      writeAttempted: true,
      cause: { code: "stale_input" },
    });
    expect(readPersistedConfig(home).daemon?.appendSystemPrompt).toBe("unfenced");
  });

  test("origin admission rejects listener mutation against the detached postcondition", () => {
    const { store, input, home } = originFixture();
    store.onApply((next) => {
      next.appendSystemPrompt = "unapproved listener change";
      return () => {};
    });
    const failure = captureConfigFailure(() => store.admitOrigin(input));
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true });
    expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).toEqual([input.origin]);
  });

  test.each([false, true])(
    "origin admission refuses resolver owner removal even with same-function replacement=%s",
    (replace) => {
      const home = mkdtempSync(path.join(tmpdir(), "vorteo-origin-owner-"));
      tempDirs.push(home);
      const persisted: PersistedConfig = { daemon: { cors: { allowedOrigins: [] } } };
      writeFileSync(path.join(home, "config.json"), JSON.stringify(persisted));
      let removeOwner = () => {};
      let ownerCalls = 0;
      const handler = () => {
        ownerCalls += 1;
      };
      const store = new DaemonConfigStore(home, reloadableConfig(persisted), undefined, {
        reloadSource: {
          resolve: (config) => {
            removeOwner();
            if (replace) store.onFieldChange("cors.allowedOrigins", handler);
            return { mutable: reloadableConfig(config), overrideControlledPaths: [] };
          },
        },
      });
      removeOwner = store.onFieldChange("cors.allowedOrigins", handler);
      expect(() =>
        store.admitOrigin({
          origin: "https://preview.example:32785",
          expectedPersistedOrigins: [],
          expectedActiveOrigins: [],
        }),
      ).toThrow(OriginAdmissionUnavailableError);
      expect(ownerCalls).toBe(0);
      expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).toEqual([]);
      expect(store.get().cors?.allowedOrigins).toEqual([]);
    },
  );

  test("origin admission holds persisted owner loss before active dispatch", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-origin-owner-"));
    tempDirs.push(home);
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ daemon: { cors: { allowedOrigins: [] } } }),
    );
    let removeOwner = () => {};
    let ownerCalls = 0;
    const logger = {
      child: () => logger,
      info: (...args: unknown[]) => {
        for (const value of args)
          if (typeof value === "string" && value.startsWith("Saved to ")) removeOwner();
      },
    };
    const store = new DaemonConfigStore(home, reloadableConfig({}), logger, {
      reloadSource: {
        resolve: (config) => ({ mutable: reloadableConfig(config), overrideControlledPaths: [] }),
      },
    });
    removeOwner = store.onFieldChange("cors.allowedOrigins", () => {
      ownerCalls += 1;
    });
    const failure = captureConfigFailure(() =>
      store.admitOrigin({
        origin: "https://preview.example:32785",
        expectedPersistedOrigins: [],
        expectedActiveOrigins: [],
      }),
    );
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true });
    expect(ownerCalls).toBe(0);
    expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).toEqual([
      "https://preview.example:32785",
    ]);
    expect(store.get().cors?.allowedOrigins).toEqual([]);
  });

  test("origin admission never returns success after field owner unregisters during apply", () => {
    const { store, input, home, removeOwner } = originFixture();
    store.onFieldChange("cors.allowedOrigins", () => {
      removeOwner();
    });
    const failure = captureConfigFailure(() => store.admitOrigin(input));
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true });
    expect(readPersistedConfig(home).daemon?.cors?.allowedOrigins).toEqual([input.origin]);
  });

  test("provider authority replaces portable fields durably without replacing local credentials", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-provider-authority-"));
    tempDirs.push(home);
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const initial = {
      ...reloadableConfig({}),
      providers: {
        codex: {
          label: "Before",
          models: [{ id: "old", label: "Old" }],
          env: { PRIVATE: "retained" },
          command: ["/local/codex"],
        },
      },
    };
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ agents: { providers: initial.providers } }),
    );
    const definitions = readInstallationProviders("host", initial.providers);
    definitions[0].policy = { label: "Shared name", enabled: true };
    const admission: InstallationSettingsAdmission = {
      ...binding,
      installationInstructions: "",
      settings: { ...readInstallationSettings(initial), providerDefinitions: definitions },
    };
    let read = async () => admission;
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      {
        installationSettingsReader: { read: () => read() },
        reloadSource: {
          resolve: (persisted) => ({
            mutable: reloadableConfig(persisted),
            overrideControlledPaths: [],
          }),
        },
      },
    );
    expect(() => store.patch({ providers: { codex: { label: "Independent" } } })).toThrow(
      "installation coordinator",
    );
    await expect(
      store.patchFromClient({ providers: { codex: { label: "Independent" } } }),
    ).rejects.toThrow("installation coordinator");
    store.patch({ providers: { codex: { env: { PRIVATE: "retained", LOCAL: "new" } } } });
    const policy = { definitions, excludedIds: [] };
    await store.patchFromClient({ installationProviderPolicy: policy });
    expect(store.get().providers.codex).toMatchObject({
      label: "Shared name",
      env: { PRIVATE: "retained", LOCAL: "new" },
      command: ["/local/codex"],
    });
    expect(store.get().providers.codex.models).toBeUndefined();
    const persisted = loadPersistedConfig(home);
    expect(persisted.agents?.providers?.codex).toMatchObject({
      label: "Shared name",
      env: { PRIVATE: "retained", LOCAL: "new" },
      command: ["/local/codex"],
    });
    expect(persisted.agents?.providers?.codex.models).toBeUndefined();
    const changed = structuredClone(persisted);
    changed.agents!.providers!.codex.label = "Disk drift";
    writeFileSync(path.join(home, "config.json"), JSON.stringify(changed));
    await expect(store.reload()).rejects.toThrow("installation coordinator");
    expect(store.get().providers.codex.label).toBe("Shared name");
    writeFileSync(path.join(home, "config.json"), JSON.stringify(persisted));
    await expect(
      store.patchFromClient({
        installationProviderPolicy: { definitions, excludedIds: [definitions[0].id] },
      }),
    ).rejects.toThrow("does not match");
    read = async () => {
      throw new Error("offline authority");
    };
    await expect(store.patchFromClient({ installationProviderPolicy: policy })).rejects.toThrow(
      "offline authority",
    );
    expect(loadPersistedConfig(home)).toEqual(persisted);
  });

  test("a catalog runtime installs only after enrollment and persists its local command and credentials", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-catalog-enrollment-"));
    tempDirs.push(home);
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const initial = reloadableConfig({});
    const admission: InstallationSettingsAdmission = {
      ...binding,
      installationInstructions: "",
      settings: { ...readInstallationSettings(initial), providerDefinitions: [] },
    };
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      { installationSettingsReader: { read: async () => admission } },
    );
    const runtime = {
      extends: "acp",
      label: "Shared runtime",
      command: ["/local/runtime"],
      env: { PRIVATE_TOKEN: "local-only" },
    };
    await expect(
      store.patchFromClient({ providers: { "catalog-runtime": runtime } }),
    ).rejects.toThrow("installation coordinator");
    admission.settings.providerDefinitions = [
      {
        id: "catalog/acp/catalog-runtime",
        providerType: "catalog-runtime",
        bindings: { host: "catalog-runtime" },
        policy: { label: "Shared runtime" },
      },
      {
        id: "unrelated-pending",
        providerType: "codex",
        bindings: { host: "missing-account" },
        policy: { label: "Pending account" },
      },
    ];
    await store.patchFromClient({ providers: { "catalog-runtime": runtime } });
    expect(store.get().providers["catalog-runtime"]).toEqual(runtime);
    expect(loadPersistedConfig(home).agents?.providers?.["catalog-runtime"]).toEqual(runtime);
    expect(JSON.stringify(admission.settings)).not.toContain("PRIVATE_TOKEN");
    await expect(
      store.patchFromClient({ providers: { "catalog-runtime": { label: "Independent" } } }),
    ).rejects.toThrow("installation coordinator");
    expect(store.get().providers["catalog-runtime"]).toEqual(runtime);
  });

  test("project exclusions mirror the installation coordinator and persist", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-project-policies-"));
    tempDirs.push(home);
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const initial = reloadableConfig({});
    const admission: InstallationSettingsAdmission = {
      ...binding,
      installationInstructions: "",
      settings: { ...readInstallationSettings(initial), projectPolicies: {} },
    };
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        installationProjectPolicies: {},
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      { installationSettingsReader: { read: async () => admission } },
    );
    const policies = { "/Users/me/dev/app": { excludedEnvironments: ["container" as const] } };
    await expect(store.patchFromClient({ installationProjectPolicies: policies })).rejects.toThrow(
      "Project exclusions must be edited through the installation coordinator",
    );
    admission.settings.projectPolicies = policies;
    await store.patchFromClient({ installationProjectPolicies: policies });
    expect(store.get().installationProjectPolicies).toEqual(policies);
    expect(loadPersistedConfig(home).daemon?.installationProjectPolicies).toEqual(policies);
  });

  test("fresh account exclusions reject delayed binding creation and concurrent local writes retry", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-excluded-account-"));
    tempDirs.push(home);
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const initial = reloadableConfig({});
    const definition = {
      id: "shared-account",
      providerType: "codex",
      bindings: { host: "local-account" },
      policy: { label: "Shared", enabled: true },
    };
    const admission: InstallationSettingsAdmission = {
      ...binding,
      installationInstructions: "",
      settings: { ...readInstallationSettings(initial), providerDefinitions: [definition] },
    };
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      { installationSettingsReader: { read: () => read() } },
    );
    let read = async () => admission;
    const before = loadPersistedConfig(home);
    admission.settings.resourceExclusions.host = {
      providerIds: [definition.id],
      terminalProfileIds: [],
      metadataProviderIds: [],
    };
    await expect(
      store.createProviderAccountBinding("local-account", {
        extends: "codex",
        label: "Shared",
        enabled: true,
        env: { CODEX_HOME: path.join(home, "account") },
      }),
    ).rejects.toThrow("excluded from this environment");
    expect(store.get().providers["local-account"]).toBeUndefined();
    expect(loadPersistedConfig(home)).toEqual(before);

    // Regression: account sync writing local settings during the authority read used to fail
    // the owner's sign-in with "settings changed". The read now repeats and the account lands.
    admission.settings.resourceExclusions.host.providerIds = [];
    let reads = 0;
    read = async () => {
      reads += 1;
      if (reads === 1) store.patch({ providers: { codex: { env: { LOCAL: "sync" } } } });
      return admission;
    };
    await store.createProviderAccountBinding("local-account", {
      extends: "codex",
      label: "Shared",
      enabled: true,
      env: { CODEX_HOME: path.join(home, "account") },
    });
    expect(reads).toBe(2);
    expect(store.get().providers["local-account"]).toMatchObject({ label: "Shared" });
  });

  test("installation settings reject independent daemon edits but retain local terminal bindings", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-authority-"));
    tempDirs.push(home);
    const terminal = { id: "shell", name: "Shell", command: "sh", cwd: "/before" };
    const store = new DaemonConfigStore(home, {
      ...reloadableConfig({}),
      terminalProfiles: [terminal],
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        providers: {},
        legacyProfiles: {},
        installation: {
          installationId: "4c07b582-7d41-4be4-9725-36f975708983",
          serverId: "host",
          environment: "host",
          revision: 1,
        },
      },
    });
    expect(() => store.patch({ appendSystemPrompt: "independent edit" })).toThrow(
      "installation coordinator",
    );
    expect(() => store.patch({ terminalProfiles: [{ ...terminal, command: "bash" }] })).toThrow(
      "installation coordinator",
    );
    store.patch({ terminalProfiles: [{ ...terminal, cwd: "/after" }] });
    expect(store.get().terminalProfiles).toEqual([{ ...terminal, cwd: "/after" }]);
    expect(store.get().appendSystemPrompt).toBe("");
  });

  test("shared policy accepts verified coordinator values, rejects divergence and offline writes, and preserves concurrent local edits", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-admission-"));
    tempDirs.push(home);
    const initial = {
      ...reloadableConfig({}),
      terminalProfiles: [{ id: "shell", name: "Shell", command: "sh", cwd: "/local" }],
    };
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const admission: InstallationSettingsAdmission = {
      ...binding,
      settings: { ...readInstallationSettings(initial), appendSystemPrompt: "Canonical" },
      installationInstructions: "",
    };
    let read = async () => admission;
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      { installationSettingsReader: { read: () => read() } },
    );
    await expect(store.patchFromClient({ appendSystemPrompt: "Independent" })).rejects.toThrow(
      "installation coordinator",
    );
    await expect(store.setAgentSkillSelection({ mode: "custom", skills: [] })).rejects.toThrow(
      "installation coordinator",
    );
    await store.patchFromClient(
      projectInstallationSettings(admission.settings, "host", store.get()),
    );
    expect(store.get().appendSystemPrompt).toBe("Canonical");
    expect(loadPersistedConfig(home).daemon?.appendSystemPrompt).toBe("Canonical");
    expect(store.get().terminalProfiles?.[0].cwd).toBe("/local");
    admission.settings.skills = { selection: { mode: "custom", skills: ["alpha"] } };
    await store.setAgentSkillSelection(admission.settings.skills.selection);
    expect(store.get().skills).toEqual(admission.settings.skills);
    expect(loadPersistedConfig(home).agents?.skills).toEqual(admission.settings.skills);
    read = async () => {
      throw new Error("coordinator offline");
    };
    await expect(store.patchFromClient({ pluginsEnabled: true })).rejects.toThrow(
      "coordinator offline",
    );
    await store.patchFromClient({
      terminalProfiles: [{ ...initial.terminalProfiles[0], cwd: "/offline-local-edit" }],
    });
    expect(store.get().terminalProfiles?.[0].cwd).toBe("/offline-local-edit");
    const pending = Promise.withResolvers<InstallationSettingsAdmission>();
    read = () => pending.promise;
    const projection = store.patchFromClient({ appendSystemPrompt: "New canonical" });
    store.patch({ providers: { codex: { env: { LOCAL_BINDING: "retained" } } } });
    pending.resolve({
      ...admission,
      settings: { ...admission.settings, appendSystemPrompt: "New canonical" },
    });
    await expect(projection).rejects.toThrow("changed while verifying");
    expect(store.get().appendSystemPrompt).toBe("Canonical");
    expect(store.get().providers.codex.env).toEqual({ LOCAL_BINDING: "retained" });
    read = async () => ({ ...admission, serverId: "another-daemon" });
    await expect(store.patchFromClient({ pluginsEnabled: true })).rejects.toThrow(
      "different installation",
    );
  });

  test("installation reload rejects independently edited policy without applying unrelated changes", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-reload-"));
    tempDirs.push(home);
    const store = new DaemonConfigStore(
      home,
      {
        ...reloadableConfig({}),
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: {
            installationId: "4c07b582-7d41-4be4-9725-36f975708983",
            serverId: "host",
            environment: "host",
            revision: 1,
          },
        },
      },
      undefined,
      {
        reloadSource: {
          resolve: (persisted) => ({
            mutable: reloadableConfig(persisted),
            overrideControlledPaths: [],
          }),
        },
      },
    );
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        daemon: { appendSystemPrompt: "Local drift", browserTools: { enabled: true } },
      }),
    );
    await expect(store.reload()).rejects.toThrow("installation coordinator");
    expect(store.get().appendSystemPrompt).toBe("");
    expect(store.get().browserTools.enabled).toBe(false);
  });

  test("removing a local account retains canonical metadata choices for other environments", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-account-"));
    tempDirs.push(home);
    const metadataGeneration = {
      providers: [{ provider: "local-account", model: "saved-choice" }],
    };
    const store = new DaemonConfigStore(home, {
      ...reloadableConfig({}),
      providers: { "local-account": { extends: "codex" } },
      metadataGeneration,
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        providers: {},
        legacyProfiles: {},
        installation: {
          installationId: "4c07b582-7d41-4be4-9725-36f975708983",
          serverId: "host",
          environment: "host",
          revision: 1,
        },
      },
    });
    store.patch({ removeProviders: ["local-account"] });
    expect(store.get().providers).toEqual({});
    expect(store.get().metadataGeneration).toEqual(metadataGeneration);
    expect(loadPersistedConfig(home).agents?.metadataGeneration).toEqual(metadataGeneration);
  });

  test("shared resource projection preserves excluded bindings durably and rejects stale local values", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-resource-bindings-"));
    tempDirs.push(paseoHome);
    const profile = {
      id: "shell",
      name: "Shell",
      command: "sh",
      cwd: "/original",
      env: { KEY: "local-only" },
    };
    const store = new DaemonConfigStore(paseoHome, {
      ...reloadableConfig({}),
      terminalProfiles: [profile],
    });
    const revision = installationResourceRevision(store.get());
    store.patch({ terminalProfiles: [{ ...profile, cwd: "/new-local-path" }] });
    const projection = {
      terminalProfiles: [],
      installationResourceBindings: { terminalProfiles: [profile], metadataProviders: [] },
      expectedInstallationResourceRevision: revision,
    };
    expect(() => store.patch(projection)).toThrow("resource bindings changed");
    expect(store.get().terminalProfiles?.[0].cwd).toBe("/new-local-path");
    const current = store.get().terminalProfiles ?? [];
    store.patch({
      ...projection,
      expectedInstallationResourceRevision: installationResourceRevision(store.get()),
      installationResourceBindings: { terminalProfiles: current, metadataProviders: [] },
    });
    expect(store.get().terminalProfiles).toEqual([]);
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.installationResourceBindings?.terminalProfiles).toEqual(current);
    const restarted = new DaemonConfigStore(paseoHome, {
      ...reloadableConfig(persisted),
      installationResourceBindings: persisted.daemon?.installationResourceBindings,
    });
    expect(restarted.get().installationResourceBindings?.terminalProfiles).toEqual(current);
  });

  test("account bindings persist and invalidate a metadata projection prepared before rebinding", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-account-bindings-"));
    tempDirs.push(paseoHome);
    const initial = reloadableConfig({
      agents: { metadataGeneration: { providers: [{ provider: "codex", model: "chosen" }] } },
    });
    initial.sharedProviderPreferences = {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: {
        installationId: "4c07b582-7d41-4be4-9725-36f975708983",
        serverId: "host",
        environment: "host",
        revision: 1,
      },
    };
    const store = new DaemonConfigStore(paseoHome, initial);
    const first = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
    store.patch({ providers: { codex: { installationAccountId: first } } });
    expect(loadPersistedConfig(paseoHome).agents?.providers?.codex.installationAccountId).toBe(
      first,
    );
    const policy = readInstallationSettings(store.get());
    const projection = projectInstallationSettings(policy, "host", store.get());
    store.patch({
      providers: { codex: { installationAccountId: "8cba85c0-d92b-4fa4-a9e8-773a9f1f01cc" } },
    });
    expect(() => store.patch(projection)).toThrow("resource bindings changed");
    expect(store.get().metadataGeneration.providers).toEqual([
      { provider: "codex", model: "chosen" },
    ]);
  });

  test("does not restore a whole stale file after an unfenced writer intervenes in failed live apply", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(home);
    const store = new DaemonConfigStore(
      home,
      reloadableConfig({ daemon: { relay: { enabled: false } } }),
    );
    const cause = new Error("Live owner failed after external write");
    store.onApply(() => {
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ daemon: { listen: "127.0.0.1:9999" } }),
      );
      throw cause;
    });
    const failure = captureConfigFailure(() => store.patch({ relay: { enabled: true } }));
    expect(failure).toBeInstanceOf(ConfigWriterError);
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true });
    expect((failure as ConfigWriterError).cause).toBeInstanceOf(AggregateError);
    expect(((failure as ConfigWriterError).cause as AggregateError).errors).toEqual([
      cause,
      expect.objectContaining({ code: "stale_input", writeAttempted: true }),
    ]);
    expect(readPersistedConfig(home).daemon).toEqual({ listen: "127.0.0.1:9999" });
    expect(store.get().relay?.enabled).toBe(false);
  });
});

describe("DaemonConfigStore reload", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function createReloadableStore(
    options: {
      overrideControlledPaths?: string[];
      initialPersisted?: PersistedConfig;
    } = {},
  ) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-reload-"));
    tempDirs.push(paseoHome);
    if (options.initialPersisted) {
      writeFileSync(
        path.join(paseoHome, "config.json"),
        `${JSON.stringify(options.initialPersisted, null, 2)}\n`,
      );
    }
    const persisted = loadPersistedConfig(paseoHome);
    const relayEnabledFallback = persisted.daemon?.relay?.enabled === undefined;
    const initialMutable = reloadableConfig(persisted, { relayEnabledFallback });
    const store = new DaemonConfigStore(paseoHome, initialMutable, undefined, {
      reloadSource: {
        resolve: (nextPersisted) => {
          const mutable = reloadableConfig(nextPersisted, { relayEnabledFallback });
          if (options.overrideControlledPaths?.includes("daemon.relay.enabled")) {
            mutable.relay = initialMutable.relay;
          }
          return {
            mutable,
            overrideControlledPaths: options.overrideControlledPaths ?? [],
          };
        },
      },
    });
    return { paseoHome, store, persisted };
  }

  function writeConfig(paseoHome: string, config: unknown): void {
    writeFileSync(path.join(paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  test("applies overlapping plugin mutations to the latest committed sources", async () => {
    const { store } = createReloadableStore({
      initialPersisted: {
        plugins: {
          a: { source: "directory", path: "/a", enabled: false },
          b: { source: "directory", path: "/b", enabled: true },
        },
      },
    });
    const enable = store.patch((current) => ({
      plugins: {
        ...current.plugins,
        a: { ...current.plugins.a!, enabled: true },
      },
    }));
    const disable = store.patch((current) => ({
      plugins: {
        ...current.plugins,
        b: { ...current.plugins.b!, enabled: false },
      },
    }));
    await Promise.all([enable, disable]);
    expect(store.get().plugins).toEqual({
      a: { source: "directory", path: "/a", enabled: true },
      b: { source: "directory", path: "/b", enabled: false },
    });
  });

  test("commits sequential patches synchronously without losing earlier fields", () => {
    const { paseoHome, store } = createReloadableStore();
    const first = store.patch({ appendSystemPrompt: "first" });
    expect(first.appendSystemPrompt).toBe("first");
    expect(store.get().appendSystemPrompt).toBe("first");
    const second = store.patch({ browserTools: { enabled: true } });
    expect(second.browserTools.enabled).toBe(true);
    expect(store.get().appendSystemPrompt).toBe("first");
    expect(store.get().browserTools.enabled).toBe(true);
    expect(loadPersistedConfig(paseoHome).daemon).toMatchObject({
      appendSystemPrompt: "first",
      browserTools: { enabled: true },
    });
  });

  test("applies mutable edits and reports startup-only edits", async () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        browserTools: { enabled: true },
        git: { maxProcessesPerSecond: 12, maxProcessConcurrency: 3 },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [
        "daemon.browserTools.enabled",
        "daemon.git.maxProcessConcurrency",
        "daemon.git.maxProcessesPerSecond",
      ],
      restartRequiredPaths: ["daemon.listen"],
      overrideControlledPaths: [],
    });
    expect(store.get().browserTools.enabled).toBe(true);
    expect(store.get().git).toEqual({ maxProcessesPerSecond: 12, maxProcessConcurrency: 3 });
  });

  test("reloads idle runtime cleanup in both directions without requiring a restart", async () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    const changes: unknown[] = [];
    store.onFieldChange("idleRuntimeCleanup", (value) => changes.push(value));
    for (const enabled of [false, true]) {
      writeConfig(paseoHome, { ...persisted, agents: { idleRuntimeCleanup: enabled } });
      expect(await store.reload()).toEqual({
        appliedPaths: ["agents.idleRuntimeCleanup"],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      });
      expect(store.get().idleRuntimeCleanup).toBe(enabled);
    }
    expect(changes).toEqual([false, true]);
    await store.patch({ idleRuntimeCleanup: false });
    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().idleRuntimeCleanup).toBe(false);
  });

  test("applies the global plugin switch in both directions", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      initialPersisted: { version: 1, pluginsEnabled: false },
    });
    const changes: unknown[] = [];
    store.onFieldChange("pluginsEnabled", (value) => changes.push(value));

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: true });
    expect(await store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(true);

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: false });
    expect(await store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("classifies every leaf when a parent subtree is added", async () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: {
          enabled: false,
          endpoint: "relay.example.test:443",
          useTls: true,
        },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: ["daemon.relay.enabled"],
      restartRequiredPaths: ["daemon.relay.endpoint", "daemon.relay.useTls"],
      overrideControlledPaths: [],
    });
  });

  test("classifies every leaf when the daemon subtree is removed", async () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: {
        version: 1,
        daemon: {
          listen: "127.0.0.1:7777",
          browserTools: { enabled: true },
          relay: {
            enabled: false,
            endpoint: "relay.example.test:443",
            useTls: true,
          },
          serviceProxy: {
            listen: "127.0.0.1:7788",
            publicBaseUrl: "https://services.example.test",
          },
        },
      },
    });
    writeConfig(paseoHome, { version: 1 });

    expect(await store.reload()).toEqual({
      appliedPaths: ["daemon.browserTools.enabled"],
      restartRequiredPaths: [
        "daemon.listen",
        "daemon.relay.endpoint",
        "daemon.relay.useTls",
        "daemon.serviceProxy.listen",
        "daemon.serviceProxy.publicBaseUrl",
      ],
      overrideControlledPaths: [],
    });
    expect(store.get().relay?.enabled).toBe(false);
  });

  test("keeps overridden leaves separate from restart-required siblings", async () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: { enabled: false, endpoint: "relay.example.test:443" },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: ["daemon.relay.endpoint"],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("invalid JSON and invalid schema apply nothing", async () => {
    const { paseoHome, store } = createReloadableStore();
    writeFileSync(path.join(paseoHome, "config.json"), "{ nope\n");
    await expect(store.reload()).rejects.toThrow("Invalid JSON");
    expect(store.get().browserTools.enabled).toBe(false);

    writeConfig(paseoHome, { daemon: { browserTools: { enabled: "yes" } } });
    await expect(store.reload()).rejects.toThrow("Invalid config");
    expect(store.get().browserTools.enabled).toBe(false);
  });

  test("removing providers and optional profiles clears live state", async () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        terminalProfiles: [{ id: "shell", name: "Shell", command: "bash" }],
        agentProfiles: [{ id: "review", name: "Review", provider: "codex" }],
      },
      agents: {
        providers: {
          gemini: { extends: "acp", label: "Gemini", command: ["gemini", "--acp"] },
        },
      },
    });
    await store.reload();

    writeConfig(paseoHome, persisted);
    const result = await store.reload();

    expect(result.appliedPaths).toEqual([
      "agents.providers",
      "daemon.agentProfiles",
      "daemon.terminalProfiles",
    ]);
    expect(store.get().providers).toEqual({});
    expect(store.get().terminalProfiles).toBeUndefined();
    expect(store.get().agentProfiles).toBeUndefined();
  });

  test("reports a launch-controlled edit without changing live state", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    const initialRelay = store.get().relay?.enabled;
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: !initialRelay } },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    expect(store.get().relay?.enabled).toBe(initialRelay);
  });

  test("an unrelated patch does not mark a manual override-owned edit as applied", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: true } },
    });
    await store.patch({ appendSystemPrompt: "patched elsewhere" });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("reports startup-only launch overrides instead of restart warnings", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        relay: {
          ...persisted.daemon?.relay,
          endpoint: "relay.example.test:443",
        },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
  });

  test("a no-op reload returns empty path lists", async () => {
    const { store } = createReloadableStore();
    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
  });
});

describe("DaemonConfigStore speech settings", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function createSpeechStore(
    initialPersisted?: unknown,
    env: NodeJS.ProcessEnv = {},
    apply?: (next: PersistedConfig) => void,
  ) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-speech-"));
    tempDirs.push(paseoHome);
    if (initialPersisted) {
      writeFileSync(
        path.join(paseoHome, "config.json"),
        `${JSON.stringify(initialPersisted, null, 2)}\n`,
      );
    }
    const persisted = loadPersistedConfig(paseoHome);
    const applied: PersistedConfig[] = [];
    const speech = {
      read: (next: PersistedConfig) => readSpeechSettings(next, env),
      apply: (next: PersistedConfig) => {
        applied.push(next);
        apply?.(next);
      },
    };
    const store = new DaemonConfigStore(paseoHome, reloadableConfig(persisted), undefined, {
      speech,
      reloadSource: {
        resolve: (next) => ({ mutable: reloadableConfig(next), overrideControlledPaths: [] }),
      },
    });
    return { paseoHome, store, applied, persisted };
  }

  test("reads, patches, and clears local STT language without losing it on other saves", async () => {
    const { paseoHome, store } = createSpeechStore({
      features: { dictation: { stt: { language: "fr" } } },
    });
    expect(store.get().features?.dictation.stt).toEqual({ provider: "local", language: "fr" });
    await store.patch({ features: { voiceMode: { enabled: true } } });
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toEqual({
      provider: "local",
      language: "fr",
    });
    const patched = await store.patch({
      features: { dictation: { stt: { provider: "local", language: "de" } } },
    });
    expect(patched.features?.dictation.stt).toEqual({ provider: "local", language: "de" });
    await store.patch({ features: { dictation: { stt: { language: null } } } });
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toEqual({ provider: "local" });
  });

  test("reports language env overrides for both local STT sites", async () => {
    const { store } = createSpeechStore(
      {},
      { PASEO_DICTATION_LANGUAGE: "fr", PASEO_VOICE_LANGUAGE: "de" },
    );
    expect(store.get().envOverrides).toMatchObject({
      "features.dictation.stt.language": "PASEO_DICTATION_LANGUAGE",
      "features.voiceMode.stt.language": "PASEO_VOICE_LANGUAGE",
    });
  });

  test("keeps voice mode off until it is turned on", async () => {
    const { paseoHome, store } = createSpeechStore();

    expect(store.get().features?.dictation.enabled).toBe(true);
    expect(store.get().features?.voiceMode.enabled).toBe(false);

    const result = await store.patch({ features: { voiceMode: { enabled: true } } });

    expect(result.features?.voiceMode.enabled).toBe(true);
    expect(loadPersistedConfig(paseoHome).features?.voiceMode?.enabled).toBe(true);
  });

  test("stores the OpenAI key without ever returning it", async () => {
    const { paseoHome, store, applied } = createSpeechStore();

    const result = await store.patch({
      features: { dictation: { stt: { provider: "openai", apiKey: " sk-test " } } },
    });

    expect(result.features?.dictation.stt).toEqual({ provider: "openai", hasApiKey: true });
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toMatchObject({
      apiKey: "sk-test",
    });
    expect(applied).toHaveLength(1);
  });

  test("applies a replaced key even though the visible settings do not change", async () => {
    const { store, applied } = createSpeechStore({
      version: 1,
      features: { dictation: { stt: { provider: "openai", apiKey: "sk-old" } } },
    });

    await store.patch({ features: { dictation: { stt: { apiKey: "sk-new" } } } });

    expect(applied.map((next) => next.features?.dictation?.stt)).toEqual([
      { provider: "openai", apiKey: "sk-new" },
    ]);
  });

  function dictationKey(config: PersistedConfig | undefined): string | undefined {
    const site = config?.features?.dictation?.stt;
    return site?.provider === "openai" ? site.apiKey : undefined;
  }

  test.each([false, true])(
    "speech transaction restores disk and live owners after apply failure (combined: %s)",
    async (combined) => {
      const applyFailure = new Error("Injected speech apply failure");
      let failNext = true;
      let liveSpeech: PersistedConfig | undefined;
      const { paseoHome, store, applied, persisted } = createSpeechStore(
        { version: 1, features: { dictation: { stt: { provider: "openai", apiKey: "sk-old" } } } },
        {},
        (next) => {
          liveSpeech = structuredClone(next);
          if (failNext && dictationKey(next) === "sk-new") {
            failNext = false;
            throw applyFailure;
          }
        },
      );
      liveSpeech = structuredClone(persisted);
      const before = store.get();
      const diskBefore = loadPersistedConfig(paseoHome);
      let fieldValue = before.browserTools.enabled;
      let listenerValue = before.appendSystemPrompt;
      const effects: string[] = [];
      const notifications: MutableDaemonConfig[] = [];
      store.onFieldChange("browserTools.enabled", (value) => {
        fieldValue = z.boolean().parse(value);
      });
      store.onApply((next, previous) => {
        effects.push("apply");
        listenerValue = next.appendSystemPrompt;
        return () => {
          effects.push("rollback");
          listenerValue = previous.appendSystemPrompt;
        };
      });
      store.onChange((next) => notifications.push(next));
      const patch = {
        ...(combined ? { browserTools: { enabled: true }, appendSystemPrompt: "changed" } : {}),
        features: { dictation: { stt: { apiKey: "sk-new" } } },
      };

      expect(() => store.patch(patch)).toThrow(ConfigWriterError);

      expect(loadPersistedConfig(paseoHome)).toEqual(diskBefore);
      expect(store.get()).toEqual(before);
      expect(liveSpeech).toEqual(persisted);
      expect(fieldValue).toBe(before.browserTools.enabled);
      expect(listenerValue).toBe(before.appendSystemPrompt);
      expect(effects).toEqual(combined ? ["apply", "rollback"] : []);
      expect(notifications).toEqual([]);
      expect(applied.map((next) => dictationKey(next))).toEqual(["sk-new", "sk-old"]);
      // A reload of restored bytes must not apply speech again: the accepted snapshot stayed old.
      await store.reload();
      expect(applied).toHaveLength(2);
      expect(store.get()).toEqual(before);

      store.patch(patch);
      expect(dictationKey(liveSpeech)).toBe("sk-new");
      expect(dictationKey(loadPersistedConfig(paseoHome))).toBe("sk-new");
      expect(notifications).toHaveLength(combined ? 1 : 0);
    },
  );

  test("speech transaction keeps reload state unaccepted until live apply succeeds", async () => {
    let failNext = true;
    let liveSpeech: PersistedConfig | undefined;
    const failure = new Error("Injected reload speech failure");
    const { paseoHome, store, persisted } = createSpeechStore(
      { version: 1, features: { voiceMode: { enabled: false } } },
      {},
      (next) => {
        liveSpeech = structuredClone(next);
        if (failNext && next.features?.voiceMode?.enabled) {
          failNext = false;
          throw failure;
        }
      },
    );
    liveSpeech = structuredClone(persisted);
    const before = store.get();
    let fieldValue = before.browserTools.enabled;
    let listenerValue = before.appendSystemPrompt;
    const notifications: MutableDaemonConfig[] = [];
    store.onFieldChange("browserTools.enabled", (value) => {
      fieldValue = z.boolean().parse(value);
    });
    store.onApply((next, previous) => {
      listenerValue = next.appendSystemPrompt;
      return () => {
        listenerValue = previous.appendSystemPrompt;
      };
    });
    store.onChange((next) => notifications.push(next));
    const edited = {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        browserTools: { enabled: true },
        appendSystemPrompt: "edited",
      },
      features: { ...persisted.features, voiceMode: { enabled: true } },
    };
    const bytes = `${JSON.stringify(edited, null, 2)}\n`;
    writeFileSync(path.join(paseoHome, "config.json"), bytes);

    await expect(store.reload()).rejects.toBe(failure);

    expect(store.get()).toEqual(before);
    expect(liveSpeech).toEqual(persisted);
    expect(fieldValue).toBe(before.browserTools.enabled);
    expect(listenerValue).toBe(before.appendSystemPrompt);
    expect(notifications).toEqual([]);
    // Reload owns live application, not the external author's edited disk bytes.
    expect(readFileSync(path.join(paseoHome, "config.json"), "utf8")).toBe(bytes);
    const retried = await store.reload();
    expect(retried.appliedPaths).toEqual(
      expect.arrayContaining([
        "daemon.browserTools.enabled",
        "daemon.appendSystemPrompt",
        "features.voiceMode",
      ]),
    );
    expect(liveSpeech?.features?.voiceMode?.enabled).toBe(true);
    expect(fieldValue).toBe(true);
    expect(listenerValue).toBe("edited");
    expect(notifications).toHaveLength(1);
  });

  test("speech transaction reports uncertain recovery when speech rollback fails", () => {
    let liveKey = "sk-old";
    const applyFailure = new Error("Injected speech apply failure");
    const rollbackFailure = new Error("Injected speech rollback failure");
    const { paseoHome, store } = createSpeechStore(
      { version: 1, features: { dictation: { stt: { provider: "openai", apiKey: "sk-old" } } } },
      {},
      (next) => {
        const key = dictationKey(next);
        if (key === "sk-old") throw rollbackFailure;
        liveKey = key ?? "";
        throw applyFailure;
      },
    );
    const before = store.get();
    const diskBefore = loadPersistedConfig(paseoHome);
    let failure: unknown;
    try {
      store.patch({ features: { dictation: { stt: { apiKey: "sk-new" } } } });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigWriterError);
    expect(failure).toMatchObject({
      code: "uncertain",
      writeAttempted: true,
      cause: { cause: applyFailure, rollbackErrors: [rollbackFailure] },
    });
    expect(store.get()).toEqual(before);
    expect(loadPersistedConfig(paseoHome)).toEqual(diskBefore);
    expect(liveKey).toBe("sk-new");
  });

  test("speech transaction refuses to overwrite a competing disk edit during rollback", () => {
    let configPath = "";
    let liveSpeech: PersistedConfig | undefined;
    const { paseoHome, store, persisted } = createSpeechStore(
      { version: 1, features: { dictation: { stt: { provider: "openai", apiKey: "sk-old" } } } },
      {},
      (next) => {
        liveSpeech = structuredClone(next);
        if (dictationKey(next) === "sk-new") {
          writeFileSync(
            configPath,
            JSON.stringify({ ...next, daemon: { appendSystemPrompt: "foreign" } }),
          );
          throw new Error("Injected speech apply failure after foreign write");
        }
      },
    );
    configPath = path.join(paseoHome, "config.json");
    liveSpeech = structuredClone(persisted);
    const before = store.get();
    let failure: unknown;
    try {
      store.patch({ features: { dictation: { stt: { apiKey: "sk-new" } } } });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigWriterError);
    expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true });
    expect(loadPersistedConfig(paseoHome).daemon?.appendSystemPrompt).toBe("foreign");
    expect(store.get()).toEqual(before);
    expect(liveSpeech).toEqual(persisted);
  });

  test("switching provider clears the previous provider's model", async () => {
    const { paseoHome, store } = createSpeechStore({
      version: 1,
      features: { dictation: { stt: { provider: "local", model: "parakeet-tdt-0.6b-v3-int8" } } },
    });

    const result = await store.patch({ features: { dictation: { stt: { provider: "openai" } } } });

    expect(result.features?.dictation.stt).toEqual({ provider: "openai", hasApiKey: false });
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toEqual({
      provider: "openai",
    });
  });

  test("rejects a local model id outside the catalog without persisting it", async () => {
    const { paseoHome, store, applied } = createSpeechStore();

    expect(() =>
      store.patch({ features: { voiceMode: { tts: { provider: "local", model: "nope" } } } }),
    ).toThrow("Unknown local voice model: nope");
    expect(loadPersistedConfig(paseoHome).features?.voiceMode).toBeUndefined();
    expect(applied).toEqual([]);
  });

  test("reload applies hand-edited speech settings without a restart", async () => {
    const { paseoHome, store, applied, persisted } = createSpeechStore();
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({ ...persisted, features: { voiceMode: { enabled: false } } }, null, 2)}\n`,
    );

    const result = await store.reload();

    expect(result.appliedPaths).toContain("features.voiceMode");
    expect(result.restartRequiredPaths).toEqual([]);
    expect(store.get().features?.voiceMode.enabled).toBe(false);
    expect(applied).toHaveLength(1);
  });
  test("merges same-provider fields and replaces the whole variant when provider changes", async () => {
    const { paseoHome, store } = createSpeechStore();
    await store.patch({
      features: {
        voiceMode: {
          stt: { provider: "openai", apiKey: "secret", baseUrl: "https://site/v1", model: "first" },
        },
      },
    });
    await store.patch({ features: { voiceMode: { stt: { model: "second", baseUrl: null } } } });
    expect(loadPersistedConfig(paseoHome).features?.voiceMode?.stt).toEqual({
      provider: "openai",
      apiKey: "secret",
      model: "second",
    });
    await store.patch({ features: { voiceMode: { stt: { provider: "openai", model: "third" } } } });
    expect(store.get().features?.voiceMode.stt).toEqual({
      provider: "openai",
      model: "third",
      hasApiKey: true,
    });
    await store.patch({ features: { voiceMode: { stt: { apiKey: "new-secret" } } } });
    await store.patch({ features: { voiceMode: { stt: { provider: "local" } } } });
    await store.patch({ features: { voiceMode: { stt: { provider: "openai" } } } });
    expect(store.get().features?.voiceMode.stt).toEqual({ provider: "openai", hasApiKey: false });
  });

  test("keeps a saved OpenAI key when a full variant patch omits the write-only key", async () => {
    const { paseoHome, store } = createSpeechStore({
      features: { voiceMode: { stt: { provider: "openai", apiKey: "saved-secret" } } },
    });
    const result = await store.patch({
      features: { voiceMode: { stt: { provider: "openai", model: "whisper-1" } } },
    });
    expect(result.features?.voiceMode.stt).toEqual({
      provider: "openai",
      model: "whisper-1",
      hasApiKey: true,
    });
    expect(loadPersistedConfig(paseoHome).features?.voiceMode?.stt).toEqual({
      provider: "openai",
      apiKey: "saved-secret",
      model: "whisper-1",
    });
    expect(JSON.stringify(result)).not.toContain("saved-secret");
  });

  test("loads a legacy host, redacts its key and writes the normalized config after any save", async () => {
    const { paseoHome, store } = createSpeechStore({
      providers: { openai: { apiKey: "legacy-secret", stt: { baseUrl: "https://old/v1" } } },
      features: { voiceMode: { enabled: true, stt: { provider: "openai" } } },
    });
    expect(store.get().features?.voiceMode.stt).toEqual({
      provider: "openai",
      baseUrl: "https://old/v1",
      hasApiKey: true,
    });
    expect(JSON.stringify(store.get())).not.toContain("legacy-secret");
    await store.patch({ autoArchiveAfterMerge: true });
    const disk = JSON.parse(readFileSync(path.join(paseoHome, "config.json"), "utf8"));
    expect(disk.providers).not.toHaveProperty("openai");
    expect(disk.features.voiceMode.stt.apiKey).toBe("legacy-secret");
  });

  test("reports env overrides and removes fallback provenance after saving a key", async () => {
    const { store } = createSpeechStore(
      { features: { voiceMode: { stt: { provider: "openai", model: "configured" } } } },
      {
        PASEO_VOICE_STT_PROVIDER: "local",
        OPENAI_API_KEY: "env-secret",
      },
    );
    expect(store.get().features?.voiceMode.stt.provider).toBe("local");
    expect(store.get().envOverrides).toEqual({
      "features.voiceMode.stt.provider": "PASEO_VOICE_STT_PROVIDER",
    });
    const other = createSpeechStore(
      { features: { voiceMode: { stt: { provider: "openai" } } } },
      {
        OPENAI_API_KEY: "env-secret",
        OPENAI_STT_BASE_URL: "https://env/v1",
        STT_MODEL: "override",
      },
    ).store;
    expect(other.get().envOverrides).toEqual({
      "features.voiceMode.stt.apiKey": "OPENAI_API_KEY",
      "features.voiceMode.stt.baseUrl": "OPENAI_STT_BASE_URL",
      "features.voiceMode.stt.model": "STT_MODEL",
    });
    expect(other.get().features?.voiceMode.stt.hasApiKey).toBe(false);
    await other.patch({
      features: { voiceMode: { stt: { apiKey: "saved-secret", baseUrl: "https://saved/v1" } } },
    });
    expect(other.get().envOverrides).toEqual({ "features.voiceMode.stt.model": "STT_MODEL" });
    expect(JSON.stringify(other.get())).not.toContain("secret");
  });
});

test("usage policy persists across restart and live reload", async () => {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "usage-policy-"));
  try {
    const initial = reloadableConfig({});
    const store = new DaemonConfigStore(paseoHome, initial, undefined, {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: reloadableConfig(persisted),
          overrideControlledPaths: [],
        }),
      },
    });
    await store.patch({ usage: { enabled: false } });
    expect(loadConfig(paseoHome, { env: {} }).usageEnabled).toBe(false);
    const persisted = loadPersistedConfig(paseoHome);
    const restarted = new DaemonConfigStore(paseoHome, reloadableConfig(persisted));
    expect(restarted.get().usage).toEqual({ enabled: false });
    writeFileSync(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ daemon: { usage: { enabled: true } } }),
    );
    await store.reload();
    expect(store.get().usage).toEqual({ enabled: true });
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
});
import { readInstallationProviders } from "./execution-installation/settings/providers.js";

import {
  readInstallationSettings,
  projectInstallationSettings,
} from "./execution-installation/settings/projection.js";

import type { InstallationSettingsAdmission } from "./execution-installation/settings/admission.js";

import { installationResourceRevision } from "./execution-installation/settings/resource-bindings.js";

import { ConfigWriterError } from "./config-writer.js";

function captureConfigFailure(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected configuration operation to reject");
}

test("registered provider defaults remain visible to migration and reload without persisting runtime inventory", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "provider-inventory-"));
  try {
    const store = new DaemonConfigStore(home, reloadableConfig({}), undefined, {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: reloadableConfig(persisted),
          overrideControlledPaths: [],
        }),
      },
    });
    store.registerProviderDefaults(["codex", "plugin-provider"]);
    expect(
      readInstallationProviders("host", store.get().providers).map((entry) => entry.bindings.host),
    ).toEqual(["codex", "plugin-provider"]);
    expect(loadPersistedConfig(home).agents?.providers).toBeUndefined();
    store.patch({ providers: { codex: { label: "Keep my name", enabled: false } } });
    store.registerProviderDefaults(["codex", "plugin-provider", "new-plugin"]);
    await store.reload();
    expect(store.get().providers).toEqual({
      codex: { label: "Keep my name", enabled: false },
      "plugin-provider": {},
      "new-plugin": {},
    });
    expect(loadPersistedConfig(home).agents?.providers).toEqual({
      codex: { label: "Keep my name", enabled: false },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
