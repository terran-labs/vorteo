import { describe, expect, it } from "vitest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";
import { settingsHaveConverged } from "../../e2e/support/helpers/settings-convergence";

const providerDefinitions: InstallationProvider[] = [
  {
    id: "shared-mock",
    providerType: "mock",
    accountId: "00000000-0000-4000-8000-000000000001",
    bindings: { host: "mock", dev: "mock" },
    policy: { label: "Updated once", enabled: true },
  },
  {
    id: "managed/00000000-0000-4000-8000-000000000002",
    providerType: "codex",
    accountSetup: { provider: "codex", creationId: "00000000-0000-4000-8000-000000000002" },
    bindings: { host: "codex-account-fixture", dev: "codex-account-fixture" },
    policy: { label: "Shared empty account", enabled: true },
  },
];
const expected = { minimumRevision: 4, providerDefinitions, serverIds: ["host", "dev"] };

function convergedSnapshot() {
  return {
    version: 1,
    revision: 5,
    settings: {
      providerDefinitions: structuredClone(providerDefinitions).toReversed(),
      timeZone: { override: null, reported: "America/Los_Angeles" },
      mcp: { injectIntoAgents: true },
      appendSystemPrompt: "",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      metadataGeneration: { providers: [] },
      pluginsEnabled: true,
      terminalProfiles: [],
      resourceExclusions: {},
    },
    sources: {
      host: { appliedRevision: 5, pendingRevision: null, error: null },
      dev: { appliedRevision: 5, pendingRevision: null, error: null },
    },
  } satisfies InstallationSettingsSnapshot;
}

interface RejectionCase {
  name: string;
  change: (sample: ReturnType<typeof convergedSnapshot>) => InstallationSettingsSnapshot;
}

const rejections: RejectionCase[] = [
  {
    name: "duplicate managed definition",
    change: (sample) => {
      sample.settings.providerDefinitions.push(structuredClone(providerDefinitions[1]));
      return sample;
    },
  },
  {
    name: "overwritten policy",
    change: (sample) => {
      sample.settings.providerDefinitions[1].policy.label = "Overwritten";
      return sample;
    },
  },
  {
    name: "dropped managed entry",
    change: (sample) => {
      sample.settings.providerDefinitions.shift();
      return sample;
    },
  },
  {
    name: "dropped existing entry",
    change: (sample) => {
      sample.settings.providerDefinitions.pop();
      return sample;
    },
  },
  {
    name: "changed binding",
    change: (sample) => {
      sample.settings.providerDefinitions[0].bindings.dev = "different-account";
      return sample;
    },
  },
  {
    name: "pending projection",
    change: (sample) => ({
      ...sample,
      sources: { ...sample.sources, dev: { ...sample.sources.dev, pendingRevision: 6 } },
    }),
  },
  {
    name: "projection error",
    change: (sample) => ({
      ...sample,
      sources: { ...sample.sources, dev: { ...sample.sources.dev, error: "verification_failed" } },
    }),
  },
  {
    name: "older applied revision",
    change: (sample) => ({
      ...sample,
      sources: { ...sample.sources, dev: { ...sample.sources.dev, appliedRevision: 4 } },
    }),
  },
  {
    name: "missing environment",
    change: (sample) => ({
      ...sample,
      sources: { host: sample.sources.host },
    }),
  },
  {
    name: "unresolved settings",
    change: (sample) => ({
      ...sample,
      settings: null,
      conflicts: { candidates: { host: sample.settings }, fields: ["providerDefinitions"] },
    }),
  },
];

describe("packaged settings convergence", () => {
  it("accepts a newer fully applied snapshot retaining the catalog after a time-zone write", () => {
    expect(settingsHaveConverged(convergedSnapshot(), expected)).toBe(true);
  });

  it.each(rejections)("rejects $name", ({ change }) => {
    expect(settingsHaveConverged(change(convergedSnapshot()), expected)).toBe(false);
  });
});
