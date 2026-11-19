import { expect, test } from "vitest";
import {
  APPLICATION_SOCKET_LEASE_MS,
  ApplicationSocketLease,
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  sendBoundedPhysicalFrame,
  sendBoundedPhysicalFrameAndWait,
} from "./physical-socket.js";

test("sockets remain exempt until they send an application ping", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const legacySocket = {};
  now = APPLICATION_SOCKET_LEASE_MS * 10;

  expect(lease.listExpired()).toEqual([]);
  lease.renew(legacySocket);
  expect(lease.listExpired()).toEqual([]);
});

test("inbound activity renews a claimed lease", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const applicationSocket = {};
  lease.claim(applicationSocket);

  now = APPLICATION_SOCKET_LEASE_MS - 1;
  lease.renew(applicationSocket);
  now += APPLICATION_SOCKET_LEASE_MS - 1;
  expect(lease.listExpired()).toEqual([]);

  now += 1;
  expect(lease.listExpired()).toEqual([applicationSocket]);
  lease.release(applicationSocket);
  expect(lease.listExpired()).toEqual([]);
});

test("an application ping claims a socket lease", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const rawSocket = {};

  lease.claim(rawSocket);
  now = APPLICATION_SOCKET_LEASE_MS;

  expect(lease.listExpired()).toEqual([rawSocket]);
});

test("the shared physical send boundary rejects binary above the hard bound", () => {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let terminated = false;
  const socket = {
    readyState: 1,
    bufferedAmount: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES - 1,
    send: (data: string | Uint8Array | ArrayBuffer) => sent.push(data),
  };

  const accepted = sendBoundedPhysicalFrame({
    socket,
    frame: new Uint8Array(2),
    onHighWater: () => {
      terminated = true;
    },
  });

  expect(accepted).toBe(false);
  expect(sent).toEqual([]);
  expect(terminated).toBe(true);
});

test("the awaitable physical send resolves only when that frame send completes", async () => {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let completeSend: (() => void) | undefined;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (_data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => {
      sent.push(_data);
      if (callback) completeSend = () => callback();
    },
  };
  let completed = false;

  const sending = sendBoundedPhysicalFrameAndWait({
    socket,
    frame: new Uint8Array([1, 2, 3]),
    onHighWater: () => undefined,
  }).then(() => {
    return (completed = true);
  });

  await Promise.resolve();
  expect(completed).toBe(false);
  expect(
    sendBoundedPhysicalFrame({
      socket,
      frame: "unrelated",
      onHighWater: () => undefined,
    }),
  ).toBe(true);
  expect(sent).toEqual([new Uint8Array([1, 2, 3]), "unrelated"]);
  completeSend?.();
  await sending;
  expect(completed).toBe(true);
});

test("the awaitable physical send rejects callback errors", async () => {
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (_data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) =>
      callback?.(new Error("send failed")),
  };

  await expect(
    sendBoundedPhysicalFrameAndWait({
      socket,
      frame: new Uint8Array([1]),
      onHighWater: () => undefined,
    }),
  ).rejects.toThrow("send failed");
});

test("ordinary frames expose a paused real socket's backlog and terminate at the physical backstop", async () => {
  const { once } = await import("node:events");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { ChunkedTransport } = await import("@getpaseo/protocol/chunked-transport");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connected = once(server, "connection");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing server address");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, "open");
  const [socket] = (await connected) as [InstanceType<typeof WebSocket>];
  const tcp = (socket as unknown as { _socket: import("node:net").Socket })._socket;
  let terminated = false;
  const transport = new ChunkedTransport({
    frameBytes: 32 * 1024 * 1024,
    deliver: () => {},
    send: (frame, wait) => {
      const options = {
        socket,
        frame,
        onHighWater: () => {
          terminated = true;
          socket.terminate();
        },
      };
      if (wait) return sendBoundedPhysicalFrameAndWait(options).then(() => undefined);
      sendBoundedPhysicalFrame(options);
    },
  });
  try {
    client.pause();
    tcp.cork();
    const frame = new Uint8Array(256 * 1024);
    for (let count = 0; count < 200; count++) await transport.send(frame);
    expect(socket.bufferedAmount).toBeGreaterThan(4 * 1024 * 1024);
    expect(transport.queuedByteLength).toBe(0);
    for (let count = 0; count < 100; count++) {
      if (terminated) break;
      await transport.send(frame);
    }
    expect(terminated).toBe(true);
  } finally {
    transport.close();
    client.terminate();
    socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an awaited framing failure terminates its real socket immediately", async () => {
  const { once } = await import("node:events");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { ChunkedTransport } = await import("@getpaseo/protocol/chunked-transport");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connected = once(server, "connection");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing server address");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, "open");
  const [socket] = (await connected) as [InstanceType<typeof WebSocket>];
  const tcp = (socket as unknown as { _socket: import("node:net").Socket })._socket;
  const transport = new ChunkedTransport({
    frameBytes: 32 * 1024 * 1024,
    deliver: () => {},
    onFailure: () => socket.terminate(),
    send: (frame) =>
      sendBoundedPhysicalFrameAndWait({
        socket,
        frame,
        onHighWater: () => socket.terminate(),
      }).then(() => undefined),
  });
  transport.enabled = true;
  try {
    client.pause();
    tcp.cork();
    const closed = once(socket, "close");
    const first = transport.send(new Uint8Array(100 * 1024 * 1024), { waitForDrain: true });
    const overflow = transport.send(new Uint8Array([1]), { waitForDrain: true });
    const settled = Promise.allSettled([first, overflow]);
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  } finally {
    transport.close();
    client.terminate();
    socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("traffic accounting separates attempts, physical outcomes, fan-out and retained reconnect windows", async () => {
  const { WebSocketTrafficMetrics } = await import("./runtime-metrics.js");
  let now = Date.UTC(2026, 10, 19);
  const metrics = new WebSocketTrafficMetrics(() => now);
  const identity = (connectionId: string) => ({
    connectionId,
    transport: "direct" as const,
    peer: "external" as const,
    browserOrigin: true,
  });
  const hello = (connectionId: string, resumed: boolean) =>
    metrics.hello({
      connectionId,
      continuityKey: "private-principal/client",
      clientType: "browser",
      resumed,
      routed: false,
    });
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
      sent.push(data);
      callback?.();
    },
  };
  for (const id of ["a", "b"]) {
    metrics.open(identity(id));
    hello(id, false);
  }
  metrics.publication(2);
  for (const id of ["a", "b"]) {
    metrics.attempt({ connectionId: id, type: "session:status", bytes: 6 });
    await sendBoundedPhysicalFrameAndWait({
      socket,
      frame: "é🌊",
      onHighWater: () => undefined,
      observe: (outcome, bytes) =>
        metrics.physical({ connectionId: id, routed: false, outcome, bytes }),
    });
    metrics.outcome("fulfilled", 6);
  }
  now += 1_500;
  metrics.publication(1);
  metrics.attempt({ connectionId: "a", type: "binary", bytes: 3 });
  sendBoundedPhysicalFrame({
    socket,
    frame: new Uint8Array([1, 2, 3]),
    onHighWater: () => undefined,
    observe: (outcome, bytes) =>
      metrics.physical({ connectionId: "a", routed: false, outcome, bytes }),
  });
  metrics.outcome("fulfilled", 3);
  const first = metrics.snapshotAndReset();
  expect(sent).toEqual(["é🌊", "é🌊", new Uint8Array([1, 2, 3])]);
  expect(first.totals.logicalAttempts).toEqual({ count: 3, bytes: 15 });
  expect(first.totals.publications).toBe(2);
  expect(first.totals.recipientCandidates).toBe(3);
  expect(first.totals.physicalFrames.accepted).toEqual({ count: 3, bytes: 15 });
  expect(first.totals.physicalFrames.completed).toEqual({ count: 2, bytes: 12 });
  expect(first.totals.physicalFrames.completionUnknown).toEqual({ count: 1, bytes: 3 });
  expect(first.connections[0].bursts.map((burst) => burst.cumulativeAttemptedBytes)).toEqual([
    6, 9, 9,
  ]);
  expect(first.connections[0].client).toBe(first.connections[1].client);
  expect(JSON.stringify(first)).not.toContain("private-principal/client");

  metrics.close("a");
  metrics.open(identity("c"));
  hello("c", true);
  now += 6_000;
  for (const [type, bytes] of [
    ["status", 2],
    ["binary", 4],
  ] as const) {
    metrics.attempt({ connectionId: "c", type, bytes });
  }
  const rejected = sendBoundedPhysicalFrame({
    socket: { ...socket, readyState: 3 },
    frame: "xx",
    onHighWater: () => undefined,
    observe: (outcome, bytes) =>
      metrics.physical({ connectionId: "c", routed: false, outcome, bytes }),
  });
  expect(rejected).toBe(false);
  metrics.outcome("synchronousRejection", 2);
  await expect(
    sendBoundedPhysicalFrameAndWait({
      socket: { ...socket, send: (_frame, callback) => callback?.(new Error("failed")) },
      frame: new Uint8Array(4),
      onHighWater: () => undefined,
      observe: (outcome, bytes) =>
        metrics.physical({ connectionId: "c", routed: false, outcome, bytes }),
    }),
  ).rejects.toThrow("failed");
  metrics.outcome("rejectedOrFailed", 4);
  const second = metrics.snapshotAndReset();
  expect(second.logicalAdmission).toBe("unknown");
  expect(second.totals.logicalAttempts).toEqual({ count: 2, bytes: 6 });
  expect(second.totals.synchronousRejection.bytes).toBe(2);
  expect(second.totals.rejectedOrFailed.bytes).toBe(4);
  expect(second.totals.physicalFrames.rejected.bytes).toBe(2);
  expect(second.totals.physicalFrames.failed.bytes).toBe(4);
  expect(second.connections[0]).toMatchObject({
    connectionId: "c",
    hello: "resumed",
    reconnectOrdinal: 2,
  });
  expect(second.connections[0].bursts.map((burst) => burst.cumulativeAttemptedBytes)).toEqual([
    0, 0, 6,
  ]);
  expect(second.connections.find((connection) => connection.connectionId === "a")?.closed).toBe(
    true,
  );
  expect(second.days[0].totals.logicalAttempts.bytes).toBe(21);
  expect(second.days[0].types.top).toEqual([
    ["session:status", 12],
    ["binary", 7],
    ["status", 2],
  ]);
  expect(second.days[0].transports).toEqual({ direct: 21 });
  expect(second.burstConnections.map((connection) => connection.connectionId)).toEqual(["c"]);
  expect(second.burstConnections[0].windows.map((burst) => burst.windowAttemptedBytes)).toEqual([
    0, 0, 6,
  ]);
  expect(
    metrics.snapshotAndReset().connections.map((connection) => connection.connectionId),
  ).not.toContain("a");

  now += 600_000;
  metrics.open(identity("expired"));
  hello("expired", true);
  expect(
    metrics
      .snapshotAndReset()
      .connections.find((connection) => connection.connectionId === "expired")?.reconnectOrdinal,
  ).toBeNull();
  for (let index = 0; index < 300; index++) {
    const id = `cap-${index}`;
    metrics.open(identity(id));
    metrics.hello({
      connectionId: id,
      continuityKey: id,
      clientType: "cli",
      resumed: false,
      routed: false,
    });
    metrics.attempt({ connectionId: id, type: `type-${index}`, bytes: 1 });
  }
  const capped = metrics.snapshotAndReset();
  expect(capped.retainedConnections).toBe(256);
  expect(capped.retainedClients).toBe(128);
  expect(capped.connectionOverflow).toBe(47);
  expect(capped.unattributedAttempts.bytes).toBe(47);
  expect(capped.totals.logicalAttempts.bytes).toBe(300);
  expect(capped.types.top.reduce((sum, [, bytes]) => sum + bytes, capped.types.other)).toBe(300);
  for (const connection of [
    "b",
    "c",
    "expired",
    ...Array.from({ length: 300 }, (_, i) => `cap-${i}`),
  ])
    metrics.close(connection);
  metrics.snapshotAndReset();
  now += 86_400_000;
  const nextDay = metrics.snapshotAndReset();
  expect(nextDay.retainedConnections).toBe(0);
  expect(nextDay.retainedClients).toBe(0);
  expect(nextDay.days.map((day) => day.totals.logicalAttempts.bytes)).toEqual([321, 0]);
});
