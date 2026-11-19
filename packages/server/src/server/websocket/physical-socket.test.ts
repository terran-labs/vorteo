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

test("server fan-out accounts each recipient and separates routed frames at the burst boundary", async () => {
  const { VoiceAssistantWebSocketServer } = await import("../websocket-server.js");
  const { VirtualHostSocket } = await import("../connected-hosts/link.js");
  const { WebSocketRuntimeMetricsWindow } = await import("./runtime-metrics.js");
  let now = 0;
  let clockThrows = false;
  const metrics = new WebSocketRuntimeMetricsWindow(() => {
    if (clockThrows) throw new Error("observer clock failed");
    return now;
  });
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  const direct = {
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: string | Uint8Array | ArrayBuffer) => {
      sent.push(frame);
    },
  };
  const routed = new VirtualHostSocket(
    async (frame) => {
      sent.push(frame);
    },
    () => undefined,
    () => 0,
    (hello) => hello,
  );
  const identities = new Map([
    [direct, { connectionId: "direct" }],
    [routed, { connectionId: "routed" }],
  ]);
  for (const [socket, { connectionId }] of identities) {
    metrics.traffic.open({
      connectionId,
      transport: "direct",
      peer: "external",
      browserOrigin: true,
    });
    metrics.traffic.hello({
      connectionId,
      continuityKey: connectionId,
      clientType: "browser",
      resumed: false,
      routed: socket === routed,
    });
  }
  // Use the actual public broadcast and send methods without constructing a listening daemon.
  const server: InstanceType<typeof VoiceAssistantWebSocketServer> = Object.create(
    VoiceAssistantWebSocketServer.prototype,
  );
  Object.assign(server, {
    runtimeMetrics: metrics,
    chunkedSockets: new WeakMap(),
    socketIdentities: identities,
    sessions: new Map(
      [...identities.keys()].map((socket) => [
        socket,
        { session: { supportsForSource: () => true } },
      ]),
    ),
    logger: { warn: () => undefined },
  });
  now = 1000;
  server.broadcast({ type: "pong" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const bytes = Buffer.byteLength(JSON.stringify({ type: "pong" }));
  const snapshot = metrics.traffic.snapshotAndReset();
  if (!("totals" in snapshot)) throw new Error("accounting failed");
  expect(sent).toHaveLength(2);
  expect(snapshot.totals.logicalAttempts).toEqual([2, bytes * 2]);
  expect(snapshot.totals.publications).toBe(1);
  expect(snapshot.totals.physicalFrames.attempted).toEqual([1, bytes]);
  expect(snapshot.totals.routedFrames.attempted).toEqual([1, bytes]);
  expect(snapshot.burstConnections[0]).toContainEqual([
    [0, 0],
    [bytes, bytes],
    [bytes, bytes],
  ]);
  clockThrows = true;
  expect(() => server.broadcast({ type: "pong" })).not.toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sent).toHaveLength(4);
  expect(metrics.traffic.snapshotAndReset().accountingErrors).toBeGreaterThan(0);
  clockThrows = false;
  metrics.traffic.dispose();
});

test("throwing observers cannot change send success or transport failure", async () => {
  const failure = new Error("transport failed");
  const observe = () => {
    throw new Error("observer failed");
  };
  for (const error of [undefined, failure]) {
    const callbackSocket = {
      readyState: 1,
      send: (_frame: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => {
        queueMicrotask(() => callback?.(error));
      },
    };
    const promisedSocket = {
      readyState: 1,
      send: () => (error ? Promise.reject(error) : Promise.resolve()),
    };
    for (const socket of [callbackSocket, promisedSocket]) {
      const result = sendBoundedPhysicalFrameAndWait({
        socket,
        frame: "é🌊",
        observe,
        onHighWater: () => undefined,
      });
      if (error) await expect(result).rejects.toBe(error);
      else await expect(result).resolves.toBe(true);
    }
    expect(
      sendBoundedPhysicalFrame({
        socket: promisedSocket,
        frame: "é🌊",
        observe,
        onHighWater: () => undefined,
      }),
    ).toBe(true);
  }
  const socket = {
    readyState: 1,
    send: () => {
      throw failure;
    },
  };
  expect(() =>
    sendBoundedPhysicalFrame({ socket, frame: "x", observe, onHighWater: () => undefined }),
  ).toThrow(failure);
  await expect(
    sendBoundedPhysicalFrameAndWait({ socket, frame: "x", observe, onHighWater: () => undefined }),
  ).rejects.toBe(failure);
  // Vitest reports any observer exception or derived-promise rejection left unhandled here.
  await new Promise<void>((resolve) => setImmediate(resolve));
});
