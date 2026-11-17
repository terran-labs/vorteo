import { expect, it } from "vitest";
import {
  deriveSystemServices,
  deriveSystemEnvironment as derive,
  type SystemEnvironmentInput,
} from "./system-status-model";
const base: SystemEnvironmentInput = {
  target: "host",
  connection: { connectionStatus: "online", lastError: null },
};
it("starts healthy", () => expect(derive(base)).toEqual({ status: "healthy", action: null }));
it.each(["offline", "idle", "error"] as const)("reconnects when %s", (connectionStatus) =>
  expect(derive({ ...base, connection: { connectionStatus, lastError: null } })).toEqual({
    status: "attention",
    action: { kind: "reconnect", label: "Reconnect" },
    reason: "This environment is not connected.",
  }),
);
it.each(["pending", "failed", "approved", "running"] as const)("handles restart %s", (status) => {
  const job = {
    id: "j",
    target: "host" as const,
    reason: "Apply changes",
    status,
  };
  expect(derive({ ...base, restartJobs: [job] }).status).toBe(
    status === "pending" || status === "failed" ? "attention" : "updating",
  );
  expect(derive({ ...base, restartJobs: [{ ...job, target: "container-daemon" }] }).status).toBe(
    "healthy",
  );
});
it.each(["pending", "approved", "running"] as const)("handles upgrade %s", (status) =>
  expect(derive({ ...base, upgrades: [{ id: "u", release: "v1", status }] }).status).toBe(
    status === "pending" ? "attention" : "updating",
  ),
);
it("requires a connection before approval and keeps approval ahead of updates", () => {
  const input: SystemEnvironmentInput = {
    ...base,
    availableVersion: "v2",
    connection: { connectionStatus: "offline", lastError: null },
    restartJobs: [{ id: "j", target: "host", status: "pending", reason: "Apply changes" }],
    upgrades: [{ id: "u", status: "pending", release: "v2" }],
  };
  expect(derive(input).action).toEqual({ kind: "reconnect", label: "Reconnect" });
  const online = { ...input, connection: base.connection };
  expect(derive(online).action).toMatchObject({
    kind: "approve-restart",
    label: "Approve restart",
    mode: "finish-current-turns",
  });
  expect(derive({ ...online, restartJobs: [] }).action?.label).toBe("Approve update");
  expect(derive({ ...input, restartJobs: [], upgrades: [] }).action?.kind).toBe("reconnect");
  expect(derive({ ...base, availableVersion: "v2" }).action?.label).toBe("Update to v2");
});
it("uses public counts when locked", () => {
  const locked = derive({
    ...base,
    locked: true,
    restartSummary: { requested: 1, queued: 0, running: 0 },
  });
  expect(locked.reason).toContain("installation");
  expect(locked.action).toBeNull();
  expect(
    derive({
      ...base,
      locked: true,
      restartSummary: { requested: 0, queued: 1, running: 0 },
    }).status,
  ).toBe("updating");
  expect(
    derive({
      ...base,
      locked: true,
      restartSummary: { requested: 1, queued: 0, running: 1 },
    }).status,
  ).toBe("attention");
});
it("tracks action reconnect and live errors", () => {
  expect(derive({ ...base, reconnectingAfterAction: true }).status).toBe("updating");
  expect(
    derive({
      ...base,
      connection: { connectionStatus: "online", lastError: "Error" },
    }).status,
  ).toBe("attention");
});

it("flags recovery and blocked readiness, and shows running service work", () => {
  const enrollment = {
    activation: "recovery-required",
    services: [],
  } as unknown as NonNullable<SystemEnvironmentInput["enrollment"]>;
  expect(derive({ ...base, enrollment }).status).toBe("attention");
  expect(
    derive({
      ...base,
      enrollment: {
        ...enrollment,
        activation: "active",
        services: [{ target: "host", readiness: "blocked" }],
      } as unknown as typeof enrollment,
    }).status,
  ).toBe("attention");
  const serviceQueue = {
    jobs: [{ target: "host", status: "running" }],
  } as unknown as SystemEnvironmentInput["serviceQueue"];
  expect(derive({ ...base, serviceQueue }).status).toBe("updating");
  expect(
    derive({
      ...base,
      serviceQueue,
      connection: { connectionStatus: "error", lastError: null },
    }).status,
  ).toBe("attention");
});

it("collapses service headlines without creating a ready row", () => {
  const ready = {
    activation: "active",
    authority: "enrolled",
    services: [{ target: "host", readiness: "ready" }],
  } as unknown as NonNullable<SystemEnvironmentInput["enrollment"]>;
  expect(deriveSystemServices(ready)).toBe(null);
  expect(deriveSystemServices({ ...ready, activation: "recovery-required" })).toBe("attention");
  expect(deriveSystemServices({ ...ready, activation: "pending" })).toBe("updating");
});

it.each(["approved", "running"] as const)(
  "shows offline %s work as updating without Reconnect",
  (status) => {
    const offline = {
      ...base,
      availableVersion: "v2",
      connection: {
        connectionStatus: "offline" as const,
        lastError: "Connection lost during restart",
      },
    };
    const job = {
      id: "restart",
      target: "host" as const,
      status,
      reason: "Apply a lengthy source update",
    };
    expect(derive({ ...offline, restartJobs: [job] })).toEqual({
      status: "updating",
      action: null,
      reason: job.reason,
    });
    expect(
      derive({ ...offline, restartJobs: [{ ...job, target: "container-daemon" }] }).action?.kind,
    ).toBe("reconnect");
    expect(derive({ ...offline, upgrades: [{ id: "upgrade", release: "v2", status }] })).toEqual({
      status: "updating",
      action: null,
    });
  },
);
it("keeps the reason separate from the fixed approval label", () => {
  const reason = "A source change with a very long explanation that must not become a button label";
  expect(
    derive({
      ...base,
      restartJobs: [{ id: "restart", target: "host", status: "pending", reason }],
    }),
  ).toMatchObject({ reason, action: { label: "Approve restart" } });
});

it("keeps a standalone update in progress ahead of its old version and lost connection", () => {
  expect(
    derive({
      ...base,
      reconnectingAfterAction: true,
      availableVersion: "v2",
      connection: { connectionStatus: "offline", lastError: "Updating" },
    }),
  ).toEqual({ status: "updating", action: null });
});

it("offers tracked Dev recovery instead of reconnecting to a worker that cannot answer", () => {
  expect(
    derive({
      ...base,
      target: "container-daemon",
      connection: { connectionStatus: "offline", lastError: "Dev is not answering" },
      restartJobs: [
        {
          id: "recovery",
          target: "container-daemon",
          status: "pending",
          reason: "Repair Dev",
          supervisorPlanSha256: "a".repeat(64),
          impact: { error: "Unavailable" } as NonNullable<
            SystemEnvironmentInput["restartJobs"]
          >[number]["impact"],
        },
      ],
    }).action,
  ).toEqual({ kind: "approve-restart", id: "recovery", label: "Repair Dev" });
});
