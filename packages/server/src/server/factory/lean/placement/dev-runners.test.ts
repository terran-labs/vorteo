import {
  AgentSnapshotPayloadSchema,
  WorkspaceDescriptorPayloadSchema,
} from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { emptyLedger } from "../state.js";
import { LEAN_PROTOCOL_MAJOR, type LeanStateStore } from "../types.js";
import { createDevPlacementVerifier, type DevPlacementOptions } from "./dev-placement.js";
import {
  createDevRunnerAdapter,
  type DevRunnerClient,
  type DevRunnerOptions,
} from "./dev-runners.js";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const installation = "host/project";
const repository = "owner/repo";
const issue = 7;
const branch = "factory/issue-7";
const now = "2026-11-27T23:00:00Z";
const reviewBranch = () => "factory/review-7-isolated";

function fixture(role: "lead" | "reviewer") {
  const ledger = emptyLedger();
  ledger.leases[issue] = {
    issue,
    branch,
    installation,
    protocol: LEAN_PROTOCOL_MAJOR,
    released: false,
    renewedAt: now,
    expiresAt: "2026-11-28T00:00:00Z",
    seenUnchangedSince: now,
  };
  const state: LeanStateStore = {
    read: async () => structuredClone(ledger),
    async mutate(_project, change) {
      return change(ledger);
    },
  };
  const checkoutBranch = role === "lead" ? branch : reviewBranch();
  const workspace = WorkspaceDescriptorPayloadSchema.parse({
    id: "workspace",
    projectId: "mirror",
    projectDisplayName: "Repo",
    projectRootPath: "/dev/repo",
    workspaceDirectory: "/dev/worktree",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "Issue worktree",
    status: "done",
    activityAt: null,
    gitRuntime: null,
    githubRuntime: null,
  });
  const agent = AgentSnapshotPayloadSchema.parse({
    id: "exact-agent",
    provider: "codex",
    cwd: "/dev/worktree",
    workspaceId: workspace.id,
    model: null,
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
  });
  let remote: typeof agent | null = null;
  let observedHead = head;
  let installationId = "trusted-installation";
  let failAfterCreate = false;
  let canReview = false;
  let planRevision = "approved-plan";
  const sent = vi.fn(async () => ({}));
  const createAgent = vi.fn(async (request: Parameters<DevRunnerClient["createAgent"]>[0]) => {
    remote = agent;
    if (failAfterCreate) {
      failAfterCreate = false;
      throw new Error("Dev connection lost after create");
    }
    request.onEvent?.({
      kind: "agent",
      idempotencyKey: request.idempotencyKey ?? "",
      phase: "completed",
      revision: 4,
      agentId: request.agentId ?? null,
      workspaceId: request.workspaceId ?? null,
      error: null,
    });
    return agent;
  });
  const client: DevRunnerClient = {
    getLastServerInfoMessage: () => ({
      status: "server_info",
      serverId: "dev",
      features: { creationLifecycle: true },
    }),
    listProjects: async () => {
      throw new Error("Unexpected project list");
    },
    createWorkspace: async () => {
      throw new Error("Unexpected workspace creation");
    },
    fetchWorkspaces: async () => ({ requestId: "workspaces", entries: [workspace] }),
    fetchAgent: async () => remote && { agent: remote, project: null },
    getCheckoutStatus: async (_cwd, request) => ({
      requestId: request?.requestId ?? "status",
      cwd: workspace.workspaceDirectory,
      isGit: true,
      isPaseoOwnedWorktree: true,
      repoRoot: workspace.workspaceDirectory,
      mainRepoRoot: "/dev/repo",
      currentBranch: checkoutBranch,
      isDirty: false,
      baseRef: "main",
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: true,
      remoteUrl: "https://github.com/owner/repo.git",
      observedHead,
      error: null,
    }),
    createAgent,
    sendMessage: sent,
    waitForFinish: async () => {
      throw new Error("Unexpected verdict read");
    },
    archiveAgent: async () => {
      throw new Error("Unexpected archive");
    },
  };
  const authority: DevPlacementOptions["readIssueAuthority"] = async () => ({
    repository,
    generation: "generation",
    claimInstallation: role === "lead" ? installation : "peer/project",
    pushedHeadSha: head,
    reviewerHeadSha: role === "reviewer" ? head : null,
    approvedPaths: ["src/a.ts"],
    planRevision,
  });
  const options: DevRunnerOptions = {
    projectId: "project",
    repository,
    installation,
    devServerId: "dev",
    state,
    now: () => new Date(now),
    readBoundInstallation: async () => ({
      installationId,
      hostServerId: "host",
      devServerId: "dev",
    }),
    authorizeForeignReview: async () => canReview,
    verifyPlacement: createDevPlacementVerifier({
      reviewBranch,
      readIssueAuthority: authority,
      resolveWorkspace: async () => ({
        repository,
        branch,
        checkoutBranch,
        workspaceId: workspace.id,
        remoteProjectId: workspace.projectId,
        cwd: workspace.workspaceDirectory,
      }),
    }),
    hosts: {
      directory: async () => ({
        self: { serverId: "host", label: "Host" },
        hosts: [
          {
            registrationId: "registration",
            serverId: "dev",
            label: null,
            source: { id: "owner", key: "vorteo-installation-dev" },
            metadata: {},
            enabled: true,
            status: "online",
            targetDescription: "Managed Dev",
            lastOnlineAt: now,
            nextRetryAt: null,
            error: null,
          },
        ],
      }),
      use: async (_server, action) => action(client),
    },
  };
  const runner = {
    agentId: agent.id,
    serverId: "dev",
    role,
    account: "codex",
    installation,
    accountDefinition: "codex-account",
    providerType: "codex",
    attempt: 1,
    openedAt: now,
  };
  const launch = {
    input: { projectId: "project", issue, role, brief: "Review issue" },
    serverId: "dev",
    worktree: undefined,
    labels: {},
    systemPrompt: "Factory",
    initialPrompt: "Start.",
    choice: {
      account: "codex",
      accountDefinition: "codex-account",
      providerType: "codex",
      profileId: null,
    },
    identity: { agentId: runner.agentId, seal: vi.fn(async () => {}) },
  };
  return {
    options,
    runner,
    launch,
    createAgent,
    sent,
    loseCreateReply: () => {
      failAfterCreate = true;
    },
    allowReview: () => {
      canReview = true;
    },
    moveHead: () => {
      observedHead = otherHead;
    },
    replaceInstallation: () => {
      installationId = "different-installation";
    },
    changePlan: () => {
      planRevision = "changed-plan";
    },
    markBusy: () => {
      remote = { ...agent, status: "running" };
    },
  };
}

describe("Dev Factory placement", () => {
  it("requires primary proof and an exact clean Reviewer checkout", async () => {
    const f = fixture("reviewer");
    const dev = createDevRunnerAdapter(f.options);
    await expect(dev.createAgent(f.launch)).rejects.toThrow("no current issue authority");
    f.allowReview();
    await expect(dev.createAgent(f.launch)).resolves.toMatchObject({ review: { headSha: head } });
    expect(await dev.verifyAssignment(f.runner.agentId)).toMatchObject({
      checkoutBranch: reviewBranch(),
      headSha: head,
    });
    f.moveHead();
    await expect(dev.verifyAssignment(f.runner.agentId)).rejects.toThrow(
      "placement could not be verified",
    );
    expect(f.createAgent).toHaveBeenCalledTimes(1);
  });

  it("adopts only after replaying the exact persisted creation request", async () => {
    const f = fixture("lead");
    f.loseCreateReply();
    const first = createDevRunnerAdapter(f.options);
    await expect(first.createAgent(f.launch)).rejects.toThrow("connection lost");
    expect(await first.verifyAssignment(f.runner.agentId)).toBeNull();
    const restarted = createDevRunnerAdapter(f.options);
    await expect(
      restarted.discoverAgent({
        issue,
        runner: f.runner,
        workspaceId: "workspace",
        choice: f.launch.choice,
      }),
    ).resolves.toBe("adopt");
    expect(f.createAgent).toHaveBeenCalledTimes(2);
    expect(f.createAgent.mock.calls[1][0]).toEqual({
      ...f.createAgent.mock.calls[0][0],
      onEvent: expect.any(Function),
    });
    await expect(restarted.verifyAssignment(f.runner.agentId)).resolves.toMatchObject({
      installationId: "trusted-installation",
    });
  });

  it("deduplicates a sent Go while busy and fences a changed installation", async () => {
    const f = fixture("lead");
    const dev = createDevRunnerAdapter(f.options);
    await dev.createAgent(f.launch);
    await expect(dev.enqueue(f.runner, "Proceed.", "go-1", "approved-plan")).resolves.toBe("sent");
    f.markBusy();
    await expect(dev.enqueue(f.runner, "Proceed.", "go-1", "approved-plan")).resolves.toBe("sent");
    await expect(dev.enqueue(f.runner, "Wait.", "go-2", "approved-plan")).resolves.toBe("busy");
    expect(f.sent).toHaveBeenCalledTimes(1);
    f.changePlan();
    await expect(dev.enqueue(f.runner, "Proceed.", "go-1", "approved-plan")).resolves.toBe("busy");
    expect(f.sent).toHaveBeenCalledTimes(1);
    f.replaceInstallation();
    await expect(dev.enqueue(f.runner, "Proceed.", "go-1", "approved-plan")).rejects.toThrow(
      "installation binding changed",
    );
  });
});
