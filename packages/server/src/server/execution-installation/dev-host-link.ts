import { createHash } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import type { Logger } from "pino";

/**
 * Saves Dev as a connected host on the Host daemon, so Host agents delegate to Dev through
 * the ordinary connected-host tools: labels, parent links, finish notices, status and prompts.
 * The Host is the more trusted side and a saved host grants no reverse access, so Dev agents
 * still cannot reach the Host.
 */
export const DEV_HOST_SOURCE_KEY = "vorteo-installation-dev";
const FINGERPRINT = "vorteo.connection-sha256";

interface LinkClient extends Pick<DaemonClient, "listHosts" | "addHost" | "updateHost" | "close"> {
  getLastServerInfoMessage(): { sourceId?: string } | null;
}

interface DevTarget {
  endpoint: string;
  password: string;
}

export function devHostConnection(target: DevTarget): string {
  const url = new URL(`ws://${target.endpoint}/ws`);
  url.searchParams.set("password", target.password);
  return url.toString();
}

export function createDevHostLinkRuntime(input: {
  container: DevTarget | undefined;
  connect(kind: ExecutionEnvironmentKind): Promise<LinkClient>;
  assertReady?(): void;
  logger: Pick<Logger, "info">;
}) {
  async function reconcile(): Promise<void> {
    if (!input.container) return;
    input.assertReady?.();
    const connection = devHostConnection(input.container);
    // Reads never return the saved connection, so a hash shows when Dev's password changed.
    const metadata = { [FINGERPRINT]: createHash("sha256").update(connection).digest("hex") };
    const client = await input.connect("host");
    try {
      // Registrations belong to a source and its key; never adopt another producer's entry.
      const sourceId = client.getLastServerInfoMessage()?.sourceId;
      if (!sourceId) throw new Error("The Host daemon does not report this connection's source");
      const { hosts } = await client.listHosts();
      const saved = hosts.find(
        (host) => host.source.id === sourceId && host.source.key === DEV_HOST_SOURCE_KEY,
      );
      if (!saved) {
        await client.addHost({
          connection,
          label: "Dev container",
          metadata,
          sourceKey: DEV_HOST_SOURCE_KEY,
        });
        input.logger.info("Saved Dev as a connected host on the Host daemon");
        return;
      }
      // A disabled registration is the owner's opt-out; only its credentials stay current.
      if (saved.metadata[FINGERPRINT] === metadata[FINGERPRINT]) return;
      await client.updateHost(saved.registrationId, { connection, metadata });
      input.logger.info("Updated the Dev connected host after its connection changed");
    } finally {
      await client.close();
    }
  }
  return { reconcile };
}
