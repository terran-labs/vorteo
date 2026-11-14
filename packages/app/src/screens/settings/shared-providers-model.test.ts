import { expect, test } from "vitest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import {
  awaitingFirstConnection,
  connectionsNeedingSignIn,
  groupInstallationProviders,
  providersNeedingAttention,
  type SignInSource,
  type ProviderDetectionSource,
} from "./shared-providers-model";

test("groups duplicate environment runtimes but preserves distinct accounts even with matching names", () => {
  const family = groupInstallationProviders([
    {
      id: "host/default",
      providerType: "codex",
      bindings: { host: "codex" },
      policy: { enabled: true },
    },
    {
      id: "dev/default",
      providerType: "codex",
      bindings: { dev: "codex" },
      policy: { enabled: false },
    },
    {
      id: "account/one",
      providerType: "codex",
      accountId: "one",
      bindings: { host: "first", dev: "second" },
      policy: { label: "Same name" },
    },
    {
      id: "account/two",
      providerType: "codex",
      accountId: "two",
      bindings: { host: "third" },
      policy: { label: "Same name" },
    },
    { id: "retired", providerType: "other", bindings: {}, policy: {}, removed: true },
  ]);
  expect(family).toHaveLength(1);
  expect(family[0].accounts.map((entry) => entry.id)).toEqual([
    "default/codex",
    "account/one",
    "account/two",
  ]);
  expect(family[0].accounts[0].definitions.map((entry) => entry.id)).toEqual([
    "host/default",
    "dev/default",
  ]);
  expect(family[0].enabled).toBe(true);
});

function builtin(type: string, policy: InstallationProvider["policy"] = {}): InstallationProvider {
  return {
    id: `environment/host/${type}`,
    providerType: type,
    bindings: { host: type, dev: type },
    policy,
  };
}

function detection(
  host: Record<string, string> | undefined,
  dev: Record<string, string> = {},
): ProviderDetectionSource[] {
  const entries = (statuses: Record<string, string>) =>
    Object.entries(statuses).map(([provider, status]) => ({ provider, status }));
  return [
    { serverId: "host", kind: "host", entries: host && entries(host) },
    { serverId: "dev", kind: "container", entries: entries(dev) },
  ];
}

test("without an owner choice a provider is on only while the Host reports it ready", () => {
  const families = groupInstallationProviders(
    [builtin("claude"), builtin("codex"), builtin("pi"), builtin("copilot")],
    "active",
    // Codex runs but needs sign-in; Copilot is ready only in Dev; Pi is installed nowhere.
    detection(
      { claude: "ready", codex: "error", pi: "unavailable", copilot: "unavailable" },
      { copilot: "ready" },
    ),
  );
  const state = Object.fromEntries(
    families.map((family) => [family.id, [family.enabled, family.installed]]),
  );
  expect(state).toEqual({
    claude: [true, true],
    codex: [false, true],
    pi: [false, false],
    copilot: [false, true],
  });
});

test("an explicit owner choice wins over detection in both directions", () => {
  const families = groupInstallationProviders(
    [builtin("claude", { enabled: false }), builtin("pi", { enabled: true })],
    "active",
    detection({ claude: "ready", pi: "unavailable" }),
  );
  expect(families.map((family) => [family.id, family.enabled, family.installed])).toEqual([
    ["claude", false, true],
    ["pi", true, false],
  ]);
});

test("detection is unknown while a snapshot loads, and off by default meanwhile", () => {
  const [loading] = groupInstallationProviders([builtin("claude")], "active", detection(undefined));
  expect([loading.enabled, loading.installed]).toEqual([false, null]);
  const [checking] = groupInstallationProviders(
    [builtin("claude")],
    "active",
    detection({ claude: "loading" }),
  );
  expect([checking.enabled, checking.installed]).toEqual([false, null]);
});

test("needs attention skips failing providers that are off by default", () => {
  const entries = [
    // Missing CLI that the owner never enabled: not attention.
    { provider: "antigravity", status: "error", enabled: true },
    // Installed but not signed in, never enabled by the owner: off, not attention.
    { provider: "codex", status: "error", enabled: true },
    // The owner turned it on, so a failure needs attention.
    { provider: "pi", status: "error", enabled: true },
    // Ready on the Host, failing here: it is on, so it needs attention.
    { provider: "claude", status: "error", enabled: true },
    { provider: "copilot", status: "unavailable", enabled: true },
  ];
  const definitions = [
    builtin("antigravity"),
    builtin("codex"),
    builtin("pi", { enabled: true }),
    builtin("claude"),
    builtin("copilot"),
  ];
  const sources = detection(
    { antigravity: "unavailable", codex: "error", pi: "error", claude: "ready" },
    Object.fromEntries(entries.map((entry) => [entry.provider, entry.status])),
  );
  expect(
    providersNeedingAttention({ entries, serverId: "dev", definitions, sources }).map(
      (entry) => entry.provider,
    ),
  ).toEqual(["pi", "claude"]);
  // A standalone daemon has no shared catalog and keeps reporting every enabled failure.
  expect(
    providersNeedingAttention({ entries, serverId: "dev", definitions: undefined, sources: [] })
      .length,
  ).toBe(4);
});

test("provider names use the manifest, then the plugin label, then a readable ID", () => {
  function name(id: string, providerType: string, label?: string) {
    return groupInstallationProviders([
      { id, providerType, policy: { label }, bindings: { host: providerType } },
    ])[0].name;
  }
  expect(name("plugin/antigravity/antigravity", "antigravity", "Antigravity")).toBe("Antigravity");
  expect(name("plugin/muse/muse", "muse", "Muse Code")).toBe("Muse Code");
  // An account's label names one connection, never the provider.
  expect(name("claude-account-1", "claude", "Claude 1")).toBe("Claude");
  expect(name("codex", "codex")).toBe("Codex");
  expect(name("custom-provider", "custom-provider")).toBe("Custom Provider");
});

test("plugin family names do not depend on account order", () => {
  const account: InstallationProvider = {
    id: "account/first",
    providerType: "custom-provider",
    bindings: {},
    policy: { label: "Personal account" },
  };
  const plugin: InstallationProvider = {
    id: "plugin/custom-provider",
    providerType: "custom-provider",
    bindings: {},
    policy: { label: "Custom CLI" },
  };
  for (const definitions of [
    [account, plugin],
    [plugin, account],
  ]) {
    expect(groupInstallationProviders(definitions)[0].name).toBe("Custom CLI");
  }
});

test("reconnect walks expired connections on Host and leaves first connections to their row", () => {
  const families = groupInstallationProviders(
    [
      {
        id: "account/work",
        providerType: "codex",
        accountId: "work",
        bindings: { host: "codex-work", dev: "codex-work" },
        policy: { label: "Work", enabled: true },
      },
      {
        id: "account/home",
        providerType: "codex",
        accountId: "home",
        bindings: { host: "codex-home" },
        policy: { label: "Home", enabled: true },
      },
      {
        id: "claude/default",
        providerType: "claude",
        bindings: { host: "claude" },
        policy: { enabled: true },
      },
    ],
    "active",
    [{ serverId: "host", kind: "host", entries: [{ provider: "codex-work", status: "ready" }] }],
  );
  const sources: SignInSource[] = [
    {
      serverId: "dev",
      kind: "container",
      providers: { "codex-work": { extends: "codex" } } as SignInSource["providers"],
      entries: [],
      usage: [],
    },
    {
      serverId: "host",
      kind: "host",
      providers: {
        "codex-work": { extends: "codex" },
        "codex-home": { extends: "codex" },
        claude: {},
      } as SignInSource["providers"],
      entries: [{ provider: "claude", status: "error", enabled: true }],
      usage: [
        {
          providerId: "codex-work",
          authRecovery: { method: "device_code", instructions: "" },
        },
        { providerId: "codex-home", status: "available" },
      ] as unknown as SignInSource["usage"],
    },
  ];
  // Sign-in runs on Host even when Dev is listed first.
  expect(connectionsNeedingSignIn(families, sources)).toMatchObject([
    { accountId: "account/work", serverId: "host", action: "Reconnect", name: "Work" },
    { accountId: "default/claude", action: "Connect" },
  ]);
  const claude = families.find((family) => family.id === "claude")!;
  claude.installed = true;
  expect(awaitingFirstConnection(claude, sources)).toMatchObject({ action: "Connect" });
  // Without a snapshot yet, a Claude connection is not called signed out.
  expect(awaitingFirstConnection(claude, [{ ...sources[1]!, entries: undefined }])).toBeNull();
});
