import { expect, it, vi } from "vitest";
import type { ExecutionInstallation, RestartJob } from "@getpaseo/protocol/execution-installation";
import type { InstallationClient } from "@/execution-installation/client";
import type { InstallationUpgrade } from "@getpaseo/protocol/installation-upgrades";
import { InstallationPanelModel } from "@/execution-installation/panel-model";
import {
  executeSystemAction,
  type SystemActionContext,
  type SystemActionPorts,
} from "./system-actions";
const job: RestartJob = {
  id: "restart",
  revision: "reviewed",
  target: "host",
  status: "pending",
  requestedBy: "host-agent",
  reason: "Apply source",
  detail: "",
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "9999-12-31T00:00:00Z",
  impact: { gracefulRestartSupported: true } as RestartJob["impact"],
};
function fixture() {
  const state = new InstallationPanelModel({} as InstallationClient).getState();
  const context: SystemActionContext = {
    serverId: "host",
    target: "host",
    installation: { gracefulRestarts: true } as ExecutionInstallation,
    state: { ...state, unlocked: true, jobs: [job], pendingJobs: [job] },
    upgrades: [],
    offer: "v2",
  };
  const ports: SystemActionPorts = {
    confirm: vi.fn(async () => true),
    reconnect: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    upgrade: vi.fn(async () => {}),
    requestUpgrade: vi.fn(async () => {}),
    updateStandalone: vi.fn(async () => {}),
  };
  return { context, ports };
}
it("confirms and uses finish turns for a reviewed restart", async () => {
  const { context, ports } = fixture();
  await executeSystemAction(
    context,
    { kind: "approve-restart", label: "Approve restart", id: job.id },
    ports,
  );
  expect(ports.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("Current turns finish") }),
  );
  expect(ports.restart).toHaveBeenCalledWith(job, "finish-current-turns");
});
it("cancellation, stale jobs, locked controls and unavailable graceful support never force a restart", async () => {
  const { context, ports } = fixture();
  const action = { kind: "approve-restart" as const, label: "Approve restart", id: job.id };
  vi.mocked(ports.confirm).mockResolvedValue(false);
  await executeSystemAction(context, action, ports);
  await expect(executeSystemAction(context, { ...action, id: "stale" }, ports)).rejects.toThrow(
    "changed",
  );
  await expect(
    executeSystemAction(
      { ...context, state: { ...context.state!, unlocked: false } },
      action,
      ports,
    ),
  ).rejects.toThrow("changed");
  await expect(
    executeSystemAction(
      { ...context, installation: { gracefulRestarts: false } as ExecutionInstallation },
      action,
      ports,
    ),
  ).rejects.toThrow("unavailable");
  expect(ports.restart).not.toHaveBeenCalled();
});
it("reconnects without requesting approval and prepares installation updates without approving", async () => {
  const { context, ports } = fixture();
  await executeSystemAction(context, { kind: "reconnect", label: "Reconnect" }, ports);
  await executeSystemAction(context, { kind: "update", label: "Update to v2" }, ports);
  expect(ports.reconnect).toHaveBeenCalledWith("host");
  expect(ports.requestUpgrade).toHaveBeenCalledWith("v2");
  expect(ports.restart).not.toHaveBeenCalled();
  expect(ports.upgrade).not.toHaveBeenCalled();
});
it("confirms standalone updates and rejects installation updates while locked", async () => {
  const { context, ports } = fixture();
  const action = { kind: "update" as const, label: "Update to v2" };
  await executeSystemAction({ ...context, installation: null }, action, ports);
  expect(ports.updateStandalone).toHaveBeenCalledWith("host");
  await expect(executeSystemAction({ ...context, state: null }, action, ports)).rejects.toThrow(
    "Unlock",
  );
});

it("keeps release approvals after current work when the installation has an update policy", async () => {
  const { context, ports } = fixture();
  const upgrade = {
    id: "release",
    revision: "reviewed",
    release: "release-26.11.500",
    status: "pending" as const,
    sourceCommit: "a".repeat(40),
    previousCommit: null,
    createdAt: "2026-11-05T00:00:00Z",
    detail: "",
    steps: [],
  };
  context.upgrades = [upgrade];
  const previous: InstallationUpgrade = {
    ...upgrade,
    id: "previous",
    status: "succeeded",
    steps: [
      {
        name: "host",
        status: "succeeded",
        startedAt: "2026-11-04T00:00:00Z",
        finishedAt: "2026-11-04T00:08:00Z",
        detail: "Host ready",
      },
    ],
  };
  context.upgradeStatus = {
    available: true,
    container: true,
    detail: "",
    repository: "owner/repo",
    current: null,
    upgrades: [upgrade, previous],
    policy: { mode: "manual", channel: "beta" },
  };
  await executeSystemAction(
    context,
    { kind: "approve-upgrade", label: "Approve update", id: upgrade.id },
    ports,
  );
  expect(ports.upgrade).toHaveBeenCalledWith(upgrade, "approve-after-work");
  expect(ports.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("The last upgrade here took about 8 minutes"),
    }),
  );
});
it("approves the exact recovery plan when Dev cannot finish turns", async () => {
  const { context, ports } = fixture();
  const recovery = {
    ...job,
    target: "container-daemon" as const,
    supervisorPlanSha256: "a".repeat(64),
    impact: { ...job.impact, error: "Dev is not answering" } as RestartJob["impact"],
  };
  context.target = "container-daemon";
  context.state = { ...context.state!, jobs: [recovery], pendingJobs: [recovery] };
  await executeSystemAction(
    context,
    { kind: "approve-restart", label: "Approve restart", id: recovery.id },
    ports,
  );
  expect(ports.restart).toHaveBeenCalledWith(recovery, "approve");
});
