import { defineSubscription } from "@getpaseo/plugin";
import { subscribePluginRpc } from "@getpaseo/plugin/client/host";
import type { PluginHandlerContext, PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { PluginProcessMessage } from "./plugin-process-protocol.js";
import { PluginSubscriptionHandlers } from "./subscription-handlers.js";

const lengths = defineSubscription({
  name: "lengths",
  input: z.object({ times: z.string().transform(Number) }),
  event: z.string().transform((text) => text.length),
});

/** The plugin process's handlers wired to the client helper through the channel between them. */
function connect(handler: (input: unknown, context: PluginSubscriptionContext) => unknown) {
  const handlers = new PluginSubscriptionHandlers(
    {
      send: (message) => deliver(message),
      sendAndWait: async (message) => deliver(message),
    },
    () => ({ paseo: {} as PaseoApi, serverId: "daemon-server" }),
  );
  handlers.register(lengths, handler);
  let observer: Parameters<Parameters<typeof subscribePluginRpc>[1]>[2] | null = null;
  function deliver(message: PluginProcessMessage) {
    if (message.type === "subscription.event") observer?.event(message.event);
    if (message.type === "subscription.closed") observer?.closed();
  }
  return (method: string, input: unknown, next: NonNullable<typeof observer>) => {
    observer = next;
    handlers.start({ type: "subscribe", requestId: "r", subscriptionId: "s", method, input });
    return Object.assign(() => handlers.release("s"), {
      ready: Promise.resolve(),
      release: async () => handlers.release("s"),
    });
  };
}

test("an event schema that transforms is applied once, on the receiving side", async () => {
  const handled: unknown[] = [];
  const received: number[] = [];
  const closed: unknown[] = [];
  const subscribe = connect(async (input, { push }) => {
    handled.push(input);
    await push("abc");
  });
  subscribePluginRpc(lengths, subscribe, { times: "2" }, (length) => received.push(length), {
    onClosed: (result) => closed.push(result),
  });
  await expect.poll(() => received).toEqual([3]);
  expect(handled).toEqual([{ times: 2 }]);
  expect(closed).toEqual([{}]);
});

test("subscription contexts refresh daemon identity without trusting plugin input", () => {
  const messages: PluginProcessMessage[] = [];
  let serverId = "daemon-first";
  const contexts: PluginHandlerContext[] = [];
  const paseo = {} as PaseoApi;
  const handlers = new PluginSubscriptionHandlers(
    { send: (message) => messages.push(message), sendAndWait: async () => {} },
    () => ({ paseo, serverId }),
  );
  handlers.register(lengths, (_input, context) => contexts.push(context));
  const start = (id: string) =>
    handlers.start({
      type: "subscribe",
      requestId: id,
      subscriptionId: id,
      method: "lengths",
      input: { times: "2", serverId: "untrusted-input" },
    });
  start("first");
  serverId = "daemon-refreshed";
  start("second");
  expect(contexts.map((context) => context.serverId)).toEqual(["daemon-first", "daemon-refreshed"]);
  expect(contexts.map((context) => context.paseo)).toEqual([paseo, paseo]);
  expect(messages).toEqual([
    { type: "result", requestId: "first", output: null },
    { type: "result", requestId: "second", output: null },
  ]);
  handlers.releaseAll();
});

test("subscription start fails closed when authenticated daemon identity is unavailable", () => {
  const messages: PluginProcessMessage[] = [];
  const handler = vi.fn();
  const handlers = new PluginSubscriptionHandlers(
    { send: (message) => messages.push(message), sendAndWait: async () => {} },
    () => {
      throw new Error("Plugin daemon identity is unavailable");
    },
  );
  handlers.register(lengths, handler);
  handlers.start({
    type: "subscribe",
    requestId: "missing",
    subscriptionId: "missing",
    method: "lengths",
    input: { times: "2", serverId: "untrusted-input" },
  });
  expect(handler).not.toHaveBeenCalled();
  expect(messages).toEqual([
    { type: "error", requestId: "missing", error: "Plugin daemon identity is unavailable" },
  ]);
  handlers.releaseAll();
});

test("void subscriptions preserve undefined across the client and server JSON boundary", async () => {
  const contract = defineSubscription({ name: "voids", input: z.void(), event: z.void() });
  const handled: unknown[] = [];
  const received: unknown[] = [];
  const wireRequests: unknown[] = [];
  const wireEvents: unknown[] = [];
  let observer: Parameters<Parameters<typeof subscribePluginRpc>[1]>[2] | null = null;
  const handlers = new PluginSubscriptionHandlers(
    {
      send: () => {},
      sendAndWait: async (message) => {
        if (message.type !== "subscription.event") throw new Error("Unexpected server message");
        const wire = JSON.parse(
          JSON.stringify({
            type: "plugin.rpc.event",
            payload: { subscriptionId: message.subscriptionId, event: message.event },
          }),
        );
        wireEvents.push(wire);
        const parsed = SessionOutboundMessageSchema.parse(wire);
        if (parsed.type !== "plugin.rpc.event") throw new Error("Unexpected event envelope");
        observer?.event(parsed.payload.event);
      },
    },
    () => ({ paseo: {} as PaseoApi, serverId: "daemon-server" }),
  );
  handlers.register(contract, (input, { push }) => {
    handled.push(input);
    return push(undefined);
  });
  const handle = subscribePluginRpc(
    contract,
    (method, input, next) => {
      observer = next;
      const wire = JSON.parse(
        JSON.stringify({
          type: "plugin.rpc.subscribe.request",
          requestId: "void-request",
          pluginId: "void-plugin",
          method,
          input,
        }),
      );
      wireRequests.push(wire);
      const request = SessionInboundMessageSchema.parse(wire);
      if (request.type !== "plugin.rpc.subscribe.request")
        throw new Error("Unexpected request envelope");
      handlers.start({
        type: "subscribe",
        requestId: request.requestId,
        subscriptionId: "void-stream",
        method: request.method,
        input: request.input,
      });
      return Object.assign(() => handlers.release("void-stream"), {
        ready: Promise.resolve(),
        release: async () => handlers.release("void-stream"),
      });
    },
    undefined,
    (event) => received.push(event),
  );
  try {
    await handle.ready;
    await expect.poll(() => received).toEqual([undefined]);
    expect(handled).toEqual([undefined]);
    expect(wireRequests).toEqual([
      {
        type: "plugin.rpc.subscribe.request",
        requestId: "void-request",
        pluginId: "void-plugin",
        method: "voids",
      },
    ]);
    expect(wireEvents).toEqual([
      { type: "plugin.rpc.event", payload: { subscriptionId: "void-stream" } },
    ]);
  } finally {
    await handle.release();
  }
});
