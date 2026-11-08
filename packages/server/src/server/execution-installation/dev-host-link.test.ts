import { describe, expect, test } from "vitest";
import type { HostAdd, HostSummary, HostUpdate } from "@getpaseo/protocol/hosts";
import { createDevHostLinkRuntime, DEV_HOST_SOURCE_KEY } from "./dev-host-link.js";

function fakeHostDaemon() {
  const hosts: (HostSummary & { connection: string })[] = [
    {
      registrationId: "hst_other",
      serverId: null,
      label: "Another producer",
      source: { id: "plugin:other", key: DEV_HOST_SOURCE_KEY },
      metadata: {},
      enabled: false,
      status: "disabled",
      targetDescription: "ws://example",
      lastOnlineAt: null,
      nextRetryAt: null,
      error: null,
      connection: "ws://example/ws",
    },
  ];
  const calls: string[] = [];
  const client = {
    getLastServerInfoMessage: () => ({ sourceId: "owner" }),
    async listHosts() {
      return {
        self: { serverId: "srv_host", label: null },
        hosts: hosts.map(({ connection: _, ...summary }) => summary),
      };
    },
    async addHost(input: HostAdd) {
      calls.push("add");
      const host = {
        registrationId: `hst_${hosts.length}`,
        serverId: null,
        label: input.label ?? null,
        source: { id: "owner", key: input.sourceKey! },
        metadata: input.metadata ?? {},
        enabled: true,
        status: "connecting" as const,
        targetDescription: "ws://127.0.0.1:7777",
        lastOnlineAt: null,
        nextRetryAt: null,
        error: null,
        connection: input.connection,
      };
      hosts.push(host);
      return host;
    },
    async updateHost(registrationId: string, patch: HostUpdate) {
      calls.push("update");
      const host = hosts.find((entry) => entry.registrationId === registrationId)!;
      Object.assign(host, patch);
      return host;
    },
    async close() {},
  };
  return { hosts, calls, client };
}

describe("Dev connected host registration", () => {
  test("saves Dev once, follows a password change and keeps the owner's opt-out", async () => {
    const daemon = fakeHostDaemon();
    const container = { endpoint: "127.0.0.1:7777", password: "first" };
    const link = createDevHostLinkRuntime({
      container,
      connect: async () => daemon.client,
      logger: { info: () => {} },
    });

    await link.reconcile();
    await link.reconcile();
    expect(daemon.calls).toEqual(["add"]);
    expect(daemon.hosts[1]).toMatchObject({
      label: "Dev container",
      source: { key: DEV_HOST_SOURCE_KEY },
      connection: "ws://127.0.0.1:7777/ws?password=first",
    });
    expect(JSON.stringify(daemon.hosts[1]!.metadata)).not.toContain("first");

    daemon.hosts[1]!.enabled = false;
    daemon.hosts[1]!.label = "Renamed by owner";
    container.password = "second";
    await link.reconcile();
    expect(daemon.calls).toEqual(["add", "update"]);
    expect(daemon.hosts[0]).toMatchObject({
      label: "Another producer",
      connection: "ws://example/ws",
    });
    expect(daemon.hosts[1]).toMatchObject({
      enabled: false,
      label: "Renamed by owner",
      connection: "ws://127.0.0.1:7777/ws?password=second",
    });
  });

  test("does nothing on an installation without Dev", async () => {
    const daemon = fakeHostDaemon();
    await createDevHostLinkRuntime({
      container: undefined,
      connect: async () => daemon.client,
      logger: { info: () => {} },
    }).reconcile();
    expect(daemon.calls).toEqual([]);
  });
});
