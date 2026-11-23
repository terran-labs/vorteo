import pino from "pino";
import { expect, test } from "vitest";
import {
  RELEASE_BACKOFF_MIN_MS,
  selectIdleHostedAgents,
  startHostedIdleRelease,
  type ReleasableAgent,
} from "./idle-release.js";

const logger = pino({ level: "silent" });
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function agent(overrides: Partial<ReleasableAgent> & { id: string }): ReleasableAgent {
  return {
    lifecycle: "idle",
    activeTurnId: null,
    pendingPermissions: { size: 0 },
    updatedAt: new Date(NOW - 10 * 60_000),
    session: { isDurablyHosted: () => true },
    ...overrides,
  };
}

test("only idle, quiet, hosted agents without a turn or a pending permission are released", () => {
  const agents = [
    agent({ id: "idle-hosted" }),
    agent({ id: "errored-hosted", lifecycle: "error" }),
    agent({ id: "errored-turn", lifecycle: "error", activeTurnId: "turn-error" }),
    agent({ id: "errored-permission", lifecycle: "error", pendingPermissions: { size: 1 } }),
    agent({ id: "running", lifecycle: "running", activeTurnId: "turn-1" }),
    agent({ id: "idle-with-turn", activeTurnId: "turn-2" }),
    agent({ id: "permission", pendingPermissions: { size: 1 } }),
    agent({ id: "recent", updatedAt: new Date(NOW - 60_000) }),
    agent({ id: "local", session: { isDurablyHosted: () => false } }),
    agent({ id: "closed", lifecycle: "closed", session: null }),
  ];
  expect(selectIdleHostedAgents(agents, NOW, 5 * 60_000).map((a) => a.id)).toEqual([
    "idle-hosted",
    "errored-hosted",
  ]);
});

test("nothing is released unless the host reports a pending upgrade", async () => {
  const closed: string[] = [];
  let pending = false;
  // A provider holding a background shell or monitor keeps its session through the upgrade.
  const watching = agent({
    id: "watching",
    session: { isDurablyHosted: () => true, canStopRuntime: async () => false },
  });
  const release = startHostedIdleRelease({
    manager: {
      listAgents: () => [agent({ id: "a" }), watching, agent({ id: "b" })],
      closeAgent: async (id, options) => {
        expect(options).toEqual({ onlyIfIdle: true });
        closed.push(id);
      },
    },
    connector: { upgradePending: async () => pending },
    logger,
    now: () => NOW,
  });
  expect(await release.runOnce()).toEqual([]);
  expect(closed).toEqual([]);
  pending = true;
  expect(await release.runOnce()).toEqual(["a", "b"]);
  expect(closed).toEqual(["a", "b"]);
  release.stop();
});

test("a release that fails for one agent still releases the others and is reported", async () => {
  const closed: string[] = [];
  const release = startHostedIdleRelease({
    manager: {
      listAgents: () => [agent({ id: "a" }), agent({ id: "b" })],
      closeAgent: async (id) => {
        if (id === "a") throw new Error("busy");
        closed.push(id);
      },
    },
    connector: { upgradePending: async () => true },
    logger,
    now: () => NOW,
  });
  expect(await release.runOnce()).toEqual(["b"]);
  expect(closed).toEqual(["b"]);
  release.stop();
});

test("a connector without the flag never releases anything", async () => {
  const release = startHostedIdleRelease({
    manager: { listAgents: () => [agent({ id: "a" })], closeAgent: async () => {} },
    connector: {},
    logger,
  });
  expect(await release.runOnce()).toEqual([]);
  release.stop();
});

test("an agent that reopens without new activity backs off until new activity resets it", async () => {
  let now = NOW;
  let pending = true;
  let returning = agent({ id: "returning" });
  const closed: string[] = [];
  const release = startHostedIdleRelease({
    manager: {
      // The agent is listed again after each close: something reopened it without a prompt.
      listAgents: () => [returning],
      closeAgent: async (id) => {
        closed.push(id);
      },
    },
    connector: { upgradePending: async () => pending },
    logger,
    now: () => now,
  });
  expect(await release.runOnce()).toEqual(["returning"]);
  now += 60_000;
  expect(await release.runOnce()).toEqual([]);
  now += RELEASE_BACKOFF_MIN_MS - 60_000;
  expect(await release.runOnce()).toEqual([]);
  now += 60_000;
  expect(await release.runOnce()).toEqual(["returning"]);
  // Reopened again with no activity: the wait doubles.
  now += 60_000;
  expect(await release.runOnce()).toEqual([]);
  now += RELEASE_BACKOFF_MIN_MS;
  expect(await release.runOnce()).toEqual([]);
  // Real activity ends the backoff; the agent is released once it is quiet again.
  returning = agent({ id: "returning", updatedAt: new Date(now - 10 * 60_000 + 1) });
  expect(await release.runOnce()).toEqual(["returning"]);
  expect(closed).toEqual(["returning", "returning", "returning"]);
  // A later upgrade starts without the previous upgrade's backoff.
  pending = false;
  expect(await release.runOnce()).toEqual([]);
  now += 3 * 24 * 60 * 60_000;
  pending = true;
  expect(await release.runOnce()).toEqual(["returning"]);
  release.stop();
});
