import { describe, expect, it, vi } from "vitest";
import type { InstallationAccountsAuthority } from "../../project/account-choice.js";
import { readDevAccountSnapshot, type AccountPlacementClient } from "./destination-accounts.js";

const heldUntil = "2026-11-28T04:00:00.000Z";
function fixture() {
  const info = { serverId: "dev", features: { factoryDestinationAccountFacts: true } };
  const authority: InstallationAccountsAuthority = {
    serverId: "host",
    settings: {
      providerDefinitions: [
        { id: "a", providerType: "codex", bindings: { host: "host-a", dev: "dev-a" }, policy: {} },
        { id: "b", providerType: "codex", bindings: { host: "host-b", dev: "dev-b" }, policy: {} },
      ],
      resourceExclusions: {
        host: { providerIds: ["b"], terminalProfileIds: [], metadataProviderIds: [] },
      },
    },
  };
  const facts = [
    { provider: "dev-a", aliasGroup: 0, heldUntil, automaticEligible: false },
    { provider: "dev-b", aliasGroup: 0, heldUntil, automaticEligible: false },
  ];
  const client = {
    getLastServerInfoMessage: vi.fn(() => info),
    getDaemonConfig: async () => ({ config: {} }),
    getProvidersSnapshot: async () => ({
      entries: facts.map(({ provider }) => ({ provider, enabled: true, status: "ready" as const })),
    }),
    listProviderUsage: vi.fn(async () => ({
      fetchedAt: "2026-11-27T22:00:00.000Z",
      providers: [],
      placementFacts: { accounts: facts },
    })),
  } satisfies AccountPlacementClient;
  const boundDevServerId = vi.fn(async () => "dev");
  const source = {
    hosts: () => ({
      use: <T>(_id: string, action: (remote: AccountPlacementClient) => Promise<T>) =>
        action(client),
    }),
    serverId: "host",
    boundDevServerId,
    readInstallationSettings: vi.fn(
      async (): Promise<InstallationAccountsAuthority | null> => authority,
    ),
  };
  return { source, client, info, authority, facts };
}

describe("Dev destination account facts", () => {
  it("uses destination facts and only installation-authorized bindings", async () => {
    const { source, client } = fixture();
    const result = await readDevAccountSnapshot(source, "dev");
    expect(client.listProviderUsage).toHaveBeenCalledWith({ placementFacts: true });
    expect(result.placement).toEqual(new Map([["host-a", "dev-a"]]));
    expect(result.installationDefinitionByProvider).toEqual({ "dev-a": "a", "dev-b": "b" });
    expect(result.destinationAliases).toEqual(
      new Map([
        ["dev-a", "0"],
        ["dev-b", "0"],
      ]),
    );
    expect(result.destinationOptOuts).toEqual(new Set(["dev-a", "dev-b"]));
    expect(result.usageLimitedUntilByProvider).toEqual({ "dev-a": heldUntil, "dev-b": heldUntil });
  });

  it("parks an older Dev before requesting the new capability", async () => {
    const { source, client, info } = fixture();
    info.features.factoryDestinationAccountFacts = false;
    await expect(readDevAccountSnapshot(source, "dev")).rejects.toThrow("Update the linked Dev");
    expect(client.listProviderUsage).not.toHaveBeenCalled();
  });

  it("rejects a changed binding even when the original daemon returned valid facts", async () => {
    const { source } = fixture();
    source.boundDevServerId.mockResolvedValueOnce("dev").mockResolvedValueOnce("replacement");
    await expect(readDevAccountSnapshot(source, "dev")).rejects.toThrow(
      "destination is unavailable or changed",
    );
  });

  it("rejects a mismatched server identity before reading account data", async () => {
    const { source, info, client } = fixture();
    info.serverId = "other";
    await expect(readDevAccountSnapshot(source, "dev")).rejects.toThrow(
      "verify its server identity",
    );
    expect(client.listProviderUsage).not.toHaveBeenCalled();
  });

  it("does not guess installation identity or accept ambiguous bindings", async () => {
    const { source, authority } = fixture();
    source.readInstallationSettings.mockResolvedValueOnce(null);
    await expect(readDevAccountSnapshot(source, "dev")).rejects.toThrow(
      "installation account definitions",
    );
    authority.settings.resourceExclusions = {};
    const second = authority.settings.providerDefinitions?.[1];
    if (!second) throw new Error("Missing fixture definition");
    second.bindings.dev = "dev-a";
    await expect(readDevAccountSnapshot(source, "dev")).rejects.toThrow(
      "ambiguous Dev account bindings",
    );
  });

  it("rejects duplicate facts even when every provider ID is represented", async () => {
    const { source, facts } = fixture();
    facts.push({ ...facts[0] });
    await expect(readDevAccountSnapshot(source, "dev")).rejects.toThrow("incomplete or duplicate");
  });
});
