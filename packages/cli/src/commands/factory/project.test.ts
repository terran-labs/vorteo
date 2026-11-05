import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFactoryState } from "@getpaseo/server/factory-project";
import { createFactoryCommand } from "./index.js";

const { connect, invoke, close, info } = vi.hoisted(() => ({
  connect: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../../utils/client.js", () => ({ connectToDaemon: connect }));

const state: ProjectFactoryState = {
  schemaVersion: 1,
  serverId: "srv",
  projectId: "prj_app",
  state: "on",
  repository: "acme/app",
  reason: null,
  workers: { workerProfileId: "worker-p", reviewerProfileId: null },
  roles: [
    {
      role: "factory-intake",
      title: "Foreman",
      workspaceId: "wks_1",
      agentId: "agent-1",
      heartbeat: { cron: "*/10 * * * *", paused: false },
      launch: { provider: null, profileId: null },
      status: null,
      instructions: { revision: 0, review: "none" },
    },
  ],
};

const instructions = {
  role: "factory-builds",
  shippedCharter: "charter",
  charterVersion: "v1",
  additions: "",
  revision: 3,
  updatedAt: null,
  history: [],
  basedOn: null,
  review: { status: "proposed", proposal: { text: "t", rationale: "r", proposedAt: "now" } },
};

let stdout: string[];
let dir: string;

async function run(...args: string[]) {
  await createFactoryCommand().parseAsync(["project", ...args], { from: "user" });
}

beforeEach(() => {
  vi.resetAllMocks();
  connect.mockResolvedValue({ invokePluginRpc: invoke, close, getLastServerInfoMessage: info });
  info.mockReturnValue({ serverId: "srv", features: { plugins: true } });
  close.mockResolvedValue(undefined);
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  dir = mkdtempSync(path.join(os.tmpdir(), "factory-project-cli-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("paseo factory project", () => {
  it("shows the stage profiles and planning setting the Foreman reads", async () => {
    invoke.mockResolvedValue({
      ...state,
      workers: { ...state.workers, plannerProfileId: "planner-p", planning: false },
    });
    await run("show", "prj_app");
    expect(invoke).toHaveBeenCalledWith("factory", "factory.project.get", { projectId: "prj_app" });
    expect(stdout.join("")).toContain("Planner profile: planner-p");
    expect(stdout.join("")).toContain("Planning: off");
    expect(stdout.join("")).toContain("Worker profile: worker-p");
    expect(stdout.join("")).toContain("Reviewer profile: default");
    expect(stdout.join("")).toContain("Drain: none");
    expect(close).toHaveBeenCalledOnce();
  });

  it("omits unsupported planning settings from an older daemon", async () => {
    invoke.mockResolvedValue(state);
    await run("show", "prj_app");
    expect(stdout.join("")).not.toContain("Planner profile:");
    expect(stdout.join("")).not.toContain("Planning:");
    expect(stdout.join("")).toContain("Worker profile: worker-p");
  });

  it("enables with a repository and repeatable adoptions", async () => {
    invoke.mockResolvedValue(state);
    await run(
      "enable",
      "prj_app",
      "--repository",
      "acme/app",
      "--adopt",
      "factory-intake=a1",
      "--adopt",
      "factory-builds=a2",
    );
    expect(invoke).toHaveBeenCalledWith("factory", "factory.project.enable", {
      projectId: "prj_app",
      repository: "acme/app",
      adopt: { "factory-intake": "a1", "factory-builds": "a2" },
    });
  });

  it("configures a role launch and clears a profile with none", async () => {
    invoke.mockResolvedValue(state);
    await run(
      "configure",
      "prj_app",
      "--role",
      "factory-intake",
      "--provider",
      "codex",
      "--planner-profile",
      "none",
      "--planning",
      "off",
      "--reviewer-profile",
      "none",
    );
    expect(invoke).toHaveBeenCalledWith("factory", "factory.project.configure", {
      projectId: "prj_app",
      role: "factory-intake",
      provider: "codex",
      plannerProfileId: null,
      planning: false,
      reviewerProfileId: null,
    });
  });

  it("sets a status line exactly as the charters call it", async () => {
    invoke.mockResolvedValue(state);
    await run("status", "set", "prj_app", "factory-builds", "deploying abc");
    expect(invoke).toHaveBeenCalledWith("factory", "factory.project.status.set", {
      projectId: "prj_app",
      role: "factory-builds",
      line: "deploying abc",
    });
  });

  it("saves instructions from a file against the current revision", async () => {
    const file = path.join(dir, "builds.md");
    writeFileSync(file, "Deploy with make ship.");
    invoke.mockResolvedValue(instructions);
    await run("instructions", "set", "prj_app", "factory-builds", "--file", file);
    expect(invoke).toHaveBeenLastCalledWith("factory", "factory.project.instructions.set", {
      projectId: "prj_app",
      role: "factory-builds",
      additions: "Deploy with make ship.",
      expectedRevision: 3,
    });
  });

  it("resolves a proposal and requires exactly one decision", async () => {
    invoke.mockResolvedValue(instructions);
    await run("instructions", "resolve", "prj_app", "factory-builds", "--dismiss");
    expect(invoke).toHaveBeenLastCalledWith("factory", "factory.project.instructions.resolve", {
      projectId: "prj_app",
      role: "factory-builds",
      accept: false,
      expectedRevision: 3,
    });
    await run("instructions", "resolve", "prj_app", "factory-builds", "--accept");
    expect(invoke).toHaveBeenLastCalledWith("factory", "factory.project.instructions.resolve", {
      projectId: "prj_app",
      role: "factory-builds",
      accept: true,
      expectedRevision: 3,
      proposedAt: "now",
    });
    await expect(run("instructions", "resolve", "prj_app", "factory-builds")).rejects.toThrow(
      "exit 1",
    );
  });

  it("refuses an unknown role before calling the daemon", async () => {
    await expect(run("status", "set", "prj_app", "factory-nope", "x")).rejects.toThrow("exit 1");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("paseo factory project drain", () => {
  const listed = {
    projects: [
      {
        projectId: "prj_app",
        state: "paused",
        repository: "acme/app",
        paused: true,
        drain: {
          id: "drain-7f3a",
          reason: "drain before restart",
          pausedAt: "2026-11-03T12:00:00.000Z",
        },
      },
    ],
  };

  it("lists every project", async () => {
    invoke.mockResolvedValue(listed);
    await run("list");
    expect(invoke).toHaveBeenCalledWith("factory", "factory.project.list", {});
    expect(stdout.join("")).toContain("drain-7f3a: drain before restart");
  });

  it("show prints the current drain id", async () => {
    invoke.mockResolvedValue({
      ...state,
      drain: { id: "drain-7f3a", reason: "drain before restart", pausedAt: "now" },
    });
    await run("show", "prj_app");
    expect(stdout.join("")).toContain("Drain: drain-7f3a (drain before restart, now)");
  });

  it("pause-all defaults its reason and accepts one", async () => {
    invoke.mockResolvedValue(listed);
    await run("pause-all");
    expect(invoke).toHaveBeenLastCalledWith("factory", "factory.project.pause_all", {
      reason: "drain before restart",
    });
    await run("pause-all", "--reason", "upgrade to 26.11.300");
    expect(invoke).toHaveBeenLastCalledWith("factory", "factory.project.pause_all", {
      reason: "upgrade to 26.11.300",
    });
  });

  it("resume-all takes no arguments", async () => {
    invoke.mockResolvedValue(listed);
    await run("resume-all");
    expect(invoke).toHaveBeenCalledWith("factory", "factory.project.resume_all", {});
  });
});
