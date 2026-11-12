import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { DemoSession } from "./session";
import { createDemoTransport } from "./transport";
import { DEMO_SERVERS } from "./installation";

import {
  demoFilePersistence,
  demoChecklistPersistence,
  demoConversationPersistence,
} from "./persistence";

// The Host holds the sample work and its saved edits; Dev, which the simulated installation adds
// on unlock, starts empty and keeps nothing.
const sessions = new Map<string, DemoSession>();

function demoSession(serverId: string): DemoSession {
  const existing = sessions.get(serverId);
  if (existing) return existing;
  const server = DEMO_SERVERS[serverId];
  if (!server) throw new Error("Real host connections are disabled in the demo.");
  const session = server.primary
    ? new DemoSession(demoFilePersistence, demoChecklistPersistence, demoConversationPersistence)
    : new DemoSession(undefined, undefined, undefined, {
        serverId,
        hostname: server.hostname,
        primary: false,
      });
  sessions.set(serverId, session);
  return session;
}

export function createDemoClient(serverId: string, clientId: string): DaemonClient {
  const session = demoSession(serverId);
  return new DaemonClient({
    url: "ws://demo.invalid/ws",
    clientId,
    expectedServerId: serverId,
    transportFactory: () => createDemoTransport(session),
    providerSnapshots: "wire",
    reconnect: { enabled: false },
  });
}
