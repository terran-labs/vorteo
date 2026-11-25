import { expect, it } from "vitest";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import type { InstallationClient } from "@/execution-installation/client";
import { InstallationPanelModel } from "@/execution-installation/panel-model";
import {
  selectSystemEnvironments,
  currentSystemRestarts,
  systemEnvironmentState,
  systemServicesState,
  type InstallationSystemState,
} from "./system-adapter-model";
import { systemHealthItems } from "./health-model";
const empty = new InstallationPanelModel({} as InstallationClient).getState();
const job = (id: string, status: RestartJob["status"], createdAt = id): RestartJob => ({
  id,
  revision: id,
  target: "host",
  requestedBy: "host-agent",
  reason: id,
  createdAt,
  expiresAt: "9999-12-31T00:00:00Z",
  status,
  detail: "",
});
// The installation's share of the "System needs attention" count: one Health row per item.
const systemAttentionCount = (
  state: InstallationSystemState,
  upgrades?: Parameters<typeof systemHealthItems>[1],
) => systemHealthItems(state, upgrades).length;
const snapshot = { connectionStatus: "online", lastError: null } as NonNullable<
  Parameters<typeof systemEnvironmentState>[0]["snapshot"]
>;
it("ignores old failures after a successful restart and superseded pending requests", () => {
  const old = job("1", "failed");
  const done = job("2", "succeeded");
  const superseded = job("0", "pending");
  const state = { ...empty, unlocked: true, jobs: [old, done, superseded] };
  expect(currentSystemRestarts(state)).toEqual([]);
  expect(systemEnvironmentState({ target: "host", snapshot, installation: state }).status).toBe(
    "healthy",
  );
  const current = job("3", "pending");
  expect(
    currentSystemRestarts({ ...state, jobs: [...state.jobs, current], pendingJobs: [current] }),
  ).toEqual([current]);
});
it("uses only public receipts while locked, even if private data remains cached", () => {
  const state = {
    ...empty,
    jobs: [job("1", "running")],
    pendingJobs: [job("2", "pending")],
    restartSummary: { requested: 2, queued: 0, running: 0 },
  };
  expect(currentSystemRestarts(state)).toEqual([]);
  // Two requested restarts are one row.
  expect(systemAttentionCount(state)).toBe(1);
  expect(
    systemEnvironmentState({ target: "host", snapshot, installation: state }).action,
  ).toBeNull();
  expect(systemServicesState(state)).toBeNull();
});
it("retains protected status through a failed poll without deriving an error from stale receipts", () => {
  const active = job("1", "running");
  const state = { ...empty, unlocked: true, jobs: [active], error: "Last known data" };
  const offline = { ...snapshot, connectionStatus: "offline" as const, lastError: "Disconnected" };
  expect(
    systemEnvironmentState({ target: "host", snapshot: offline, installation: state }),
  ).toMatchObject({ status: "updating", action: null });
  expect(
    systemEnvironmentState({ target: "container-daemon", snapshot: offline, installation: state })
      .action?.kind,
  ).toBe("reconnect");
});
it("combines restart, upgrade, recovery and readiness attention in one count", () => {
  const pending = job("1", "pending");
  const enrollmentStatus = {
    activation: "recovery-required",
    services: [{ target: "host", readiness: "blocked" }],
  } as InstallationSystemState["enrollmentStatus"];
  const state = {
    ...empty,
    unlocked: true,
    jobs: [pending],
    pendingJobs: [pending],
    enrollmentStatus,
  };
  expect(
    systemAttentionCount(state, [{ status: "pending" }] as unknown as Parameters<
      typeof systemAttentionCount
    >[1]),
  ).toBe(4);
  expect(systemServicesState(state)).toBe("attention");
});
it("uses version and transport alone without an installation", () => {
  expect(
    systemEnvironmentState({ target: "host", snapshot, installation: null, availableVersion: "v2" })
      .action?.label,
  ).toBe("Update to v2");
  expect(
    systemEnvironmentState({
      target: "host",
      snapshot: { ...snapshot, connectionStatus: "offline" },
      installation: null,
    }).action?.kind,
  ).toBe("reconnect");
});
it("includes public System services requests and recovery in the locked notice", () => {
  expect(
    systemAttentionCount({
      ...empty,
      restartSummary: {
        requested: 1,
        queued: 5,
        running: 0,
        nativeHelper: { requested: 2, queued: 0, recovery: 1 },
      } as InstallationSystemState["restartSummary"],
    }),
    // One row for restarts and one for the native helper.
  ).toBe(2);
});

it("respects explicit, installation, selected and first-host precedence", () => {
  const hosts = [{ serverId: "first" }, { serverId: "selected" }];
  const installation = {
    environments: [
      { kind: "host", serverId: "installation-host" },
      { kind: "container", serverId: "installation-dev" },
    ],
  } as NonNullable<Parameters<typeof selectSystemEnvironments>[0]>;
  expect(selectSystemEnvironments(installation, hosts, "explicit", "selected")).toEqual({
    hostId: "explicit",
    devId: "installation-dev",
  });
  expect(selectSystemEnvironments(installation, hosts, undefined, "selected")).toEqual({
    hostId: "installation-host",
    devId: "installation-dev",
  });
  expect(selectSystemEnvironments(null, hosts, undefined, "selected").hostId).toBe("selected");
  expect(selectSystemEnvironments(null, hosts, undefined, "removed").hostId).toBe("first");
});

it("reports a failed live interface through Host status and the single notice, excluding locked data", () => {
  const liveDev = {
    available: true,
    mode: "live" as const,
    reason: null,
    revision: "r",
    changedAt: null,
    checkout: null,
    server: { state: "failed" as const, detail: "Live interface stopped" },
  };
  const state = { ...empty, unlocked: true, liveDev };
  expect(systemEnvironmentState({ target: "host", snapshot, installation: state }).status).toBe(
    "attention",
  );
  expect(
    systemEnvironmentState({ target: "container-daemon", snapshot, installation: state }).status,
  ).toBe("healthy");
  expect(systemAttentionCount(state)).toBe(1);
  expect(systemAttentionCount({ ...state, unlocked: false })).toBe(0);
});

// #639: a failure counts until a later success on the same target or the owner's dismissal.
// The failure that is the latest state of its target always counts.
const record = (status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id: `${status}-${createdAt}`,
  status,
  createdAt,
  ...extra,
});
const broker = (status: string, createdAt: string, extra?: Record<string, unknown>) =>
  record(status, createdAt, { target: "preview-broker", ...extra });
const host = (status: string, createdAt: string, extra?: Record<string, unknown>) =>
  record(status, createdAt, { target: "session-host", ...extra });
it.each([
  [
    "broker failure superseded by a later success",
    { brokerJobs: [broker("failed", "1"), broker("succeeded", "2")] },
    [],
    [],
  ],
  [
    "broker failure after a success",
    { brokerJobs: [broker("succeeded", "1"), broker("failed", "2")] },
    [],
    ["broker"],
  ],
  [
    "success on another target does not supersede",
    {
      brokerJobs: [
        broker("failed", "1"),
        broker("succeeded", "2", { target: "preview-broker-deployment" }),
      ],
    },
    [],
    ["broker"],
  ],
  [
    "failed session host install, then a successful restart",
    {
      sessionHost: {
        jobs: [
          host("failed", "2026-11-14T00:00:00Z", { operation: "session-host-install" }),
          host("succeeded", "2026-11-14T00:00:00.500Z", { operation: "session-host-restart" }),
        ],
        status: null,
      },
    },
    [],
    ["session-host"],
  ],
  [
    // As strings, "…00.500Z" sorts before "…00Z"; parsed, it is half a second later.
    "failed session host install, then a successful install half a second later",
    {
      sessionHost: {
        jobs: [
          host("failed", "2026-11-14T00:00:00Z", { operation: "session-host-install" }),
          host("succeeded", "2026-11-14T00:00:00.500Z", { operation: "session-host-install" }),
        ],
        status: null,
      },
    },
    [],
    [],
  ],
  [
    "dismissed session host failure",
    { sessionHost: { jobs: [host("failed", "1", { acknowledgedAt: "2" })], status: null } },
    [],
    [],
  ],
  [
    "failed upgrade, not automatic, superseded",
    {},
    [record("failed", "1"), record("succeeded", "2")],
    [],
  ],
  [
    "dismissed upgrade failure",
    {},
    [record("failed", "1", { automatic: true, acknowledgedAt: "2" })],
    [],
  ],
  ["latest upgrade failed", {}, [record("succeeded", "1"), record("failed", "2")], ["upgrades"]],
  [
    "stale instruction request",
    {
      instructionRequests: {
        revision: 2,
        appendSystemPrompt: "",
        requests: [record("pending", "1", { baseRevision: 1 })],
      },
    },
    [],
    [],
  ],
  [
    "current instruction request",
    {
      instructionRequests: {
        revision: 2,
        appendSystemPrompt: "",
        requests: [record("pending", "1", { baseRevision: 2 })],
      },
    },
    [],
    ["instructions"],
  ],
])("Health counting: %s", (_name, fields, upgrades, rows) => {
  const state = { ...empty, unlocked: true, ...fields } as unknown as InstallationSystemState;
  expect(
    systemHealthItems(state, upgrades as unknown as Parameters<typeof systemHealthItems>[1]).map(
      (item) => item.id,
    ),
  ).toEqual(rows);
});
