import { getAgentPresentationIndex } from "@/subagents/policies";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabSnapshot,
  deriveEnvironmentWorkspaceAgentVisibility,
  createEnvironmentWorkspaceVisibilitySelector,
  createWorkspaceAgentVisibilitySelector,
  deriveWorkspaceAgentVisibility,
  shouldPruneWorkspaceAgentTab,
  workspaceAgentVisibilityEqual,
} from "@/workspace-tabs/agent-visibility";

function makeAgent(input: {
  id: string;
  cwd: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  lastActivityAt?: Date;
}): Agent {
  const createdAt = input.createdAt ?? new Date("2026-03-04T00:00:00.000Z");
  const lastActivityAt = input.lastActivityAt ?? createdAt;
  return {
    serverId: "srv",
    id: input.id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    model: null,
    thinkingOptionId: null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

const WORKSPACE_ID = "ws-1";

describe("workspace agent visibility", () => {
  it("removes a restored pinned tab from an unrelated workspace once its owner is known", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const original = createWorkspaceLayoutStore(undefined, storage);
    await original.persist.rehydrate();
    const agent = makeAgent({ id: "restored-agent", cwd: "/project-a", workspaceId: "ws-a" });
    for (const workspaceId of ["ws-a", "ws-b"]) {
      original.getState().openTab({
        workspaceKey: `srv:${workspaceId}`,
        target: { kind: "agent", agentId: agent.id },
        intent: "reveal",
        pin: true,
      });
    }
    const restored = createWorkspaceLayoutStore(undefined, storage);
    await restored.persist.rehydrate();
    const sessionAgents = new Map([[agent.id, agent]]);
    const beforeHydration = buildWorkspaceTabSnapshot({
      agentVisibility: deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "ws-b" }),
      agentsHydrated: false,
      terminalsHydrated: true,
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingTerminalCreate: false,
      hasActivePendingDraftCreate: false,
    });
    restored.getState().reconcileTabs("srv:ws-b", beforeHydration);
    expect(restored.getState().pinnedAgentIdsByWorkspace["srv:ws-b"]).toEqual(new Set([agent.id]));
    for (const workspaceId of ["ws-a", "ws-b"]) {
      restored.getState().reconcileTabs(
        `srv:${workspaceId}`,
        buildWorkspaceTabSnapshot({
          agentVisibility: deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId }),
          agentsHydrated: true,
          terminalsHydrated: true,
          knownTerminalIds: [],
          standaloneTerminalIds: [],
          hasActivePendingTerminalCreate: false,
          hasActivePendingDraftCreate: false,
        }),
      );
    }

    expect(
      restored
        .getState()
        .getWorkspaceTabs("srv:ws-a")
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.target),
    ).toEqual([{ kind: "agent", agentId: agent.id }]);
    expect(
      restored
        .getState()
        .getWorkspaceTabs("srv:ws-b")
        .filter((tab) => tab.target.kind === "agent"),
    ).toEqual([]);
    expect(restored.getState().pinnedAgentIdsByWorkspace["srv:ws-b"]).toBeUndefined();
  });

  it("uses directory ownership before historical details when identifying foreign agents", () => {
    const own = makeAgent({ id: "own", cwd: "/repo", workspaceId: WORKSPACE_ID });
    const foreign = makeAgent({ id: "foreign", cwd: "/repo", workspaceId: "ws-2" });
    const unknown = makeAgent({ id: "unknown", cwd: "/repo" });
    const result = deriveWorkspaceAgentVisibility({
      workspaceId: WORKSPACE_ID,
      sessionAgents: new Map([
        [own.id, own],
        [foreign.id, foreign],
        [unknown.id, unknown],
      ]),
      agentDetails: new Map([
        [own.id, { ...own, workspaceId: "ws-2" }],
        [foreign.id, { ...foreign, workspaceId: WORKSPACE_ID }],
        [unknown.id, { ...unknown, workspaceId: "ws-2" }],
      ]),
    });

    expect(result.activeAgentIds).toEqual(new Set([own.id]));
    expect(result.foreignAgentIds).toEqual(new Set([foreign.id]));
  });

  it("recognizes foreign historical ownership without making archived or unknown agents foreign", () => {
    const archived = makeAgent({
      id: "archived",
      cwd: "/repo",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const foreign = { ...archived, id: "foreign", workspaceId: "ws-2" };
    const unknown = { ...archived, id: "unknown", workspaceId: undefined };
    const result = deriveWorkspaceAgentVisibility({
      workspaceId: WORKSPACE_ID,
      sessionAgents: new Map(),
      agentDetails: new Map([
        [archived.id, archived],
        [foreign.id, foreign],
        [unknown.id, unknown],
      ]),
    });

    expect(result.activeAgentIds).toEqual(new Set());
    expect(result.foreignAgentIds).toEqual(new Set([foreign.id]));
  });

  it("keeps subagents active while excluding them from auto-open", () => {
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [parent.id, parent],
        [child.id, child],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["parent-agent", "child-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
    expect(result.foreignAgentIds).toEqual(new Set());
  });

  it("excludes archived subagents from active and auto-open", () => {
    const archivedChild = makeAgent({
      id: "archived-child",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([[archivedChild.id, archivedChild]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.autoOpenAgentIds).toEqual(new Set<string>());
  });

  it("excludes a child from auto-open even when its snapshot arrives before the parent", () => {
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [child.id, child],
        [parent.id, parent],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["child-agent", "parent-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
  });

  it("presents an isolated worker beneath its parent without changing execution identity", () => {
    const parent = makeAgent({ id: "parent", cwd: "/repo", workspaceId: "parent-workspace" });
    const child = makeAgent({
      id: "worker",
      cwd: "/isolated/worktree",
      workspaceId: "worker-workspace",
      parentAgentId: parent.id,
    });
    const sessionAgents = new Map([
      [parent.id, parent],
      [child.id, child],
    ]);
    const parentView = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: parent.workspaceId,
    });
    expect(parentView.activeAgentIds).toEqual(new Set(["parent", "worker"]));
    expect(parentView.autoOpenAgentIds).toEqual(new Set(["parent"]));
    expect(
      deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: child.workspaceId })
        .activeAgentIds,
    ).toEqual(new Set(["worker"]));
    expect(child.workspaceId).toBe("worker-workspace");
    expect(child.cwd).toBe("/isolated/worktree");
  });

  it("excludes archived agents from the active directory", () => {
    const visible = makeAgent({
      id: "visible-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    const archived = makeAgent({
      id: "archived-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
      createdAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const otherWorkspace = makeAgent({
      id: "other-workspace-agent",
      cwd: "/repo/other",
      workspaceId: "ws-other",
    });

    const sessionAgents = new Map<string, Agent>([
      [visible.id, visible],
      [archived.id, archived],
      [otherWorkspace.id, otherWorkspace],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["visible-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["visible-agent"]));
  });

  it("does not make historical details active", () => {
    const active = makeAgent({
      id: "active-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const historicalDetail = makeAgent({
      id: "historical-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([[active.id, active]]),
      agentDetails: new Map([[historicalDetail.id, historicalDetail]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["active-agent"]));
  });

  it("prunes archived agent tabs so archiving on one client closes tabs on all clients", () => {
    const activeAgentIds = new Set<string>();

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(true);
  });

  it("prunes pinned archived agent tabs because archive state is authoritative", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("does not prune active agent tabs", () => {
    const activeAgentIds = new Set(["active-agent"]);

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "active-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(false);
  });

  it("prunes agent tabs once agents are hydrated and the agent is missing from activeAgentIds", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "missing-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("matches agents by workspaceId regardless of cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "stamped-agent",
        makeAgent({
          id: "stamped-agent",
          cwd: "/repo/subdir",
          workspaceId: "ws-1",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set(["stamped-agent"]));
  });

  it("excludes a stamped agent whose workspaceId belongs to another workspace sharing the cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "other-ws-agent",
        makeAgent({
          id: "other-ws-agent",
          cwd: "/repo/worktree",
          workspaceId: "ws-2",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.foreignAgentIds).toEqual(new Set(["other-ws-agent"]));
  });

  it("excludes agents without a workspaceId", () => {
    const sessionAgents = new Map<string, Agent>([
      ["ownerless-agent", makeAgent({ id: "ownerless-agent", cwd: "/repo/worktree" })],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.foreignAgentIds).toEqual(new Set<string>());
  });

  it("builds the tab reconciliation snapshot without callers unpacking agent visibility", () => {
    const agentVisibility = {
      activeAgentIds: new Set(["active-agent"]),
      autoOpenAgentIds: new Set(["root-agent"]),
      foreignAgentIds: new Set(["foreign-agent"]),
    };

    expect(
      buildWorkspaceTabSnapshot({
        agentVisibility,
        agentsHydrated: true,
        terminalsHydrated: true,
        knownTerminalIds: ["terminal-1", "script-terminal"],
        standaloneTerminalIds: ["terminal-1"],
        hasActivePendingTerminalCreate: false,
        hasActivePendingDraftCreate: false,
      }),
    ).toEqual({
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: agentVisibility.activeAgentIds,
      autoOpenAgentIds: agentVisibility.autoOpenAgentIds,
      foreignAgentIds: agentVisibility.foreignAgentIds,
      knownTerminalIds: ["terminal-1", "script-terminal"],
      standaloneTerminalIds: ["terminal-1"],
      hasActivePendingTerminalCreate: false,
      hasActivePendingDraftCreate: false,
    });
  });

  describe("createWorkspaceAgentVisibilitySelector", () => {
    const SERVER_ID = "srv";

    class IterationCountingMap<K, V> extends Map<K, V> {
      iterations = 0;
      override values() {
        this.iterations += 1;
        return super.values();
      }
      override entries() {
        this.iterations += 1;
        return super.entries();
      }
      override [Symbol.iterator]() {
        this.iterations += 1;
        return super[Symbol.iterator]();
      }
    }

    function seedSession(agents: Map<string, Agent>): void {
      useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
      useSessionStore.getState().setAgents(SERVER_ID, agents);
    }

    function streamTick(text: string): void {
      useSessionStore.getState().setAgentStreamState(SERVER_ID, "parent-agent", {
        head: [
          {
            kind: "assistant_message",
            id: "message-1",
            text,
            timestamp: new Date("2026-03-04T00:02:00.000Z"),
          },
        ],
      });
    }

    const parent = makeAgent({ id: "parent-agent", cwd: "/repo", workspaceId: WORKSPACE_ID });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo",
      workspaceId: WORKSPACE_ID,
      parentAgentId: parent.id,
    });
    const otherWorkspace = makeAgent({ id: "other-agent", cwd: "/other", workspaceId: "ws-2" });

    afterEach(() => {
      useSessionStore.getState().clearSession(SERVER_ID);
    });

    it("returns the cached result without walking agents when a stream tick leaves them unchanged", () => {
      const agents = new IterationCountingMap<string, Agent>([
        [parent.id, parent],
        [otherWorkspace.id, otherWorkspace],
      ]);
      seedSession(agents);
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());
      const iterationsAfterFirstSelect = agents.iterations;

      for (let tick = 0; tick < 100; tick += 1) {
        streamTick(`token ${tick}`);
        expect(select(useSessionStore.getState())).toBe(before);
      }

      expect(useSessionStore.getState().sessions[SERVER_ID]?.agents).toBe(agents);
      expect(agents.iterations).toBe(iterationsAfterFirstSelect);
      expect(before.activeAgentIds).toEqual(new Set([parent.id]));
    });

    it("recomputes when the agents map changes", () => {
      const agents = new Map([[parent.id, parent]]);
      seedSession(agents);
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());

      useSessionStore.getState().setAgents(SERVER_ID, new Map(agents).set(child.id, child));
      const after = select(useSessionStore.getState());

      expect(after).not.toBe(before);
      expect(after.activeAgentIds).toEqual(new Set([parent.id, child.id]));
      expect(after.autoOpenAgentIds).toEqual(new Set([parent.id]));
    });

    it("keeps the previous result when a changed agents map yields the same sets", () => {
      const agents = new Map([
        [parent.id, parent],
        [otherWorkspace.id, otherWorkspace],
      ]);
      seedSession(agents);
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());

      useSessionStore
        .getState()
        .setAgents(
          SERVER_ID,
          new Map(agents).set(otherWorkspace.id, { ...otherWorkspace, title: "Renamed" }),
        );

      expect(select(useSessionStore.getState())).toBe(before);
    });

    it("keeps an orphan reachable when details reveal a parent in another workspace", () => {
      seedSession(new Map([[child.id, child]]));
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      expect(select(useSessionStore.getState()).autoOpenAgentIds).toEqual(new Set([child.id]));

      useSessionStore
        .getState()
        .setAgentDetails(
          SERVER_ID,
          new Map([[parent.id, { ...parent, workspaceId: "ws-parent" }]]),
        );
      const after = select(useSessionStore.getState());

      expect(after.activeAgentIds).toEqual(new Set([child.id]));
      expect(after.autoOpenAgentIds).toEqual(new Set([child.id]));
    });

    it("recomputes when only a previously unknown agent's foreign ownership becomes known", () => {
      seedSession(new Map([[parent.id, parent]]));
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());
      useSessionStore
        .getState()
        .setAgentDetails(SERVER_ID, new Map([[otherWorkspace.id, otherWorkspace]]));
      const after = select(useSessionStore.getState());

      expect(after).not.toBe(before);
      expect(after.activeAgentIds).toEqual(before.activeAgentIds);
      expect(after.autoOpenAgentIds).toEqual(before.autoOpenAgentIds);
      expect(after.foreignAgentIds).toEqual(new Set([otherWorkspace.id]));
    });
  });

  describe("workspaceAgentVisibilityEqual", () => {
    it("returns true for identical sets", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set(["c"]),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set(["c"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });

    it("returns false when activeAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set(["b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns false when autoOpenAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["b"]),
        foreignAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns true for empty sets", () => {
      const a = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
        foreignAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
        foreignAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });
  });
});

describe("managed worker presentation", () => {
  it("keeps nested descendants in the originating task with independent tasks alongside them", () => {
    const parent = makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo" });
    const child = makeAgent({
      id: "child",
      workspaceId: "worktree-one",
      cwd: "/worktrees/one",
      parentAgentId: "parent",
    });
    const grandchild = makeAgent({
      id: "grandchild",
      workspaceId: "worktree-two",
      cwd: "/worktrees/two",
      parentAgentId: "child",
    });
    const independent = makeAgent({
      id: "independent",
      workspaceId: "worktree-one",
      cwd: "/worktrees/one",
    });
    const sessionAgents = new Map(
      [parent, child, grandchild, independent].map((entry) => [entry.id, entry]),
    );
    const origin = deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "origin" });
    expect(origin.activeAgentIds).toEqual(new Set(["parent", "child", "grandchild"]));
    expect(origin.autoOpenAgentIds).toEqual(new Set(["parent"]));
    const worktree = deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "worktree-one" });
    expect(worktree.activeAgentIds).toEqual(new Set(["child", "independent"]));
    expect(worktree.autoOpenAgentIds).toEqual(new Set(["child", "independent"]));
    expect(grandchild.cwd).toBe("/worktrees/two");
    expect(grandchild.workspaceId).toBe("worktree-two");
  });
  it.each(["missing", "archived"])("keeps a worker visible when its parent is %s", (state) => {
    const child = makeAgent({
      id: "child",
      workspaceId: "worktree",
      cwd: "/worktree",
      parentAgentId: "parent",
    });
    const sessionAgents = new Map([[child.id, child]]);
    if (state === "archived")
      sessionAgents.set(
        "parent",
        makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo", archivedAt: new Date(1) }),
      );
    const result = deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "worktree" });
    expect(result.activeAgentIds).toEqual(new Set(["child"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
  });
  it("keeps descendants with the nearest live ancestor when the originating parent is absent", () => {
    const child = makeAgent({
      id: "child",
      workspaceId: "worktree",
      cwd: "/worktree",
      parentAgentId: "absent",
    });
    const grandchild = makeAgent({
      id: "grandchild",
      workspaceId: "nested",
      cwd: "/nested",
      parentAgentId: "child",
    });
    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([
        [child.id, child],
        [grandchild.id, grandchild],
      ]),
      workspaceId: "worktree",
    });
    expect(result.activeAgentIds).toEqual(new Set(["child", "grandchild"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
  });
  it("does not hide workers whose parent metadata contains a cycle", () => {
    const one = makeAgent({
      id: "one",
      workspaceId: "one-workspace",
      cwd: "/one",
      parentAgentId: "two",
    });
    const two = makeAgent({
      id: "two",
      workspaceId: "two-workspace",
      cwd: "/two",
      parentAgentId: "one",
    });
    const sessionAgents = new Map([
      [one.id, one],
      [two.id, two],
    ]);
    expect(
      deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: one.workspaceId })
        .autoOpenAgentIds,
    ).toEqual(new Set(["one"]));
    expect(
      deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: two.workspaceId })
        .autoOpenAgentIds,
    ).toEqual(new Set(["two"]));
  });
});

it("keeps a worker accessible if its parent workspace is no longer in the active directory", () => {
  const parent = makeAgent({ id: "parent", workspaceId: "gone", cwd: "/repo" });
  const child = makeAgent({
    id: "child",
    workspaceId: "execution",
    cwd: "/worktree",
    parentAgentId: "parent",
  });
  const sessionAgents = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const result = deriveWorkspaceAgentVisibility({
    sessionAgents,
    workspaceId: "execution",
    workspaces: new Map(),
  });
  expect(result.activeAgentIds).toEqual(new Set(["child"]));
  expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
});
it("reuses ancestry indexes without rescanning unchanged metadata and separates workspace availability contexts", () => {
  const parent = makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo" });
  const child = makeAgent({
    id: "child",
    workspaceId: "execution",
    cwd: "/worktree",
    parentAgentId: "parent",
  });
  const agents = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const withoutDirectory = getAgentPresentationIndex(agents);
  const unavailableWorkspaces = new Map<string, WorkspaceDescriptor>();
  const withDirectory = getAgentPresentationIndex(agents, unavailableWorkspaces);
  expect(withoutDirectory.get("child")?.workspaceId).toBe("origin");
  expect(withDirectory.get("child")?.workspaceId).toBe("execution");
  const scanning = vi.spyOn(agents, "values").mockImplementation(() => {
    throw new Error("Unexpected ancestry rescan");
  });
  try {
    expect(getAgentPresentationIndex(agents)).toBe(withoutDirectory);
    expect(getAgentPresentationIndex(agents, unavailableWorkspaces)).toBe(withDirectory);
  } finally {
    scanning.mockRestore();
  }
  const archived = new Map(agents);
  archived.set(parent.id, { ...parent, archivedAt: new Date(1) });
  expect(getAgentPresentationIndex(archived).get("child")?.workspaceId).toBe("execution");
});

it("keeps execution-workspace recovery when the parent workspace remains available", () => {
  const parent = makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo" });
  const child = makeAgent({
    id: "child",
    workspaceId: "execution",
    cwd: "/worktree",
    parentAgentId: "parent",
  });
  const origin: WorkspaceDescriptor = {
    id: "origin",
    createdAt: null,
    lastUserMessageAt: null,
    projectId: "project",
    projectDisplayName: "project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "origin",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
  const sessionAgents = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const result = deriveWorkspaceAgentVisibility({
    sessionAgents,
    workspaceId: "execution",
    workspaces: new Map([
      [origin.id, origin],
      [
        "execution",
        { ...origin, id: "execution", workspaceDirectory: "/worktree", name: "execution" },
      ],
    ]),
  });
  expect(result.activeAgentIds).toEqual(new Set(["child"]));
  expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
});

it("does not prune saved destination tabs before the owning workspace hydrates", () => {
  const visibility = deriveEnvironmentWorkspaceAgentVisibility({
    serverId: "host",
    workspaceId: "source",
    sessions: {
      container: {
        agents: new Map(),
        agentDetails: new Map(),
        workspaces: new Map(),
        hasHydratedAgents: true,
        hasHydratedWorkspaces: true,
      },
    },
  });
  expect(visibility.hydratedEnvironmentIds).toEqual(new Set());
});

it("carries known foreign ownership into environment workspace reconciliation", () => {
  const local = makeAgent({ id: "local", workspaceId: "current", cwd: "/current" });
  const foreign = makeAgent({ id: "foreign", workspaceId: "other", cwd: "/other" });
  const companion = makeAgent({
    id: "companion-agent",
    workspaceId: "companion",
    cwd: "/companion",
  });
  const current: WorkspaceDescriptor = {
    id: "current",
    createdAt: null,
    lastUserMessageAt: null,
    projectId: "project",
    projectDisplayName: "Repo",
    projectRootPath: "/repo",
    workspaceDirectory: "/current",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Current",
    status: "done",
    statusEnteredAt: null,
    diffStat: null,
    archivingAt: null,
    scripts: [],
  };
  const member: WorkspaceDescriptor = {
    ...current,
    id: "companion",
    workspaceDirectory: "/companion",
    projectMembership: {
      key: "project",
      name: "Project",
      environmentOwner: { serverId: "host", workspaceId: "current" },
    },
  };
  const visibility = deriveEnvironmentWorkspaceAgentVisibility({
    serverId: "host",
    workspaceId: "current",
    sessions: {
      host: {
        agents: new Map([
          [local.id, local],
          [companion.id, companion],
          [foreign.id, foreign],
        ]),
        agentDetails: new Map(),
        workspaces: new Map([
          [current.id, current],
          [member.id, member],
        ]),
        hasHydratedAgents: true,
        hasHydratedWorkspaces: true,
      },
    },
  });
  expect(visibility.activeAgentIds).toEqual(new Set([local.id, companion.id]));
  expect(visibility.foreignAgentIds).toEqual(new Set([foreign.id]));
});

it("refreshes environment foreign ownership when agent details arrive", () => {
  const serverId = "foreign-details-cache";
  useSessionStore.getState().initializeSession(serverId, null, 1);
  try {
    const initial = useSessionStore.getState().sessions[serverId]!;
    const current: WorkspaceDescriptor = {
      id: "current",
      createdAt: null,
      lastUserMessageAt: null,
      projectId: "project",
      projectDisplayName: "Repo",
      projectRootPath: "/repo",
      workspaceDirectory: "/current",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "Current",
      status: "done",
      statusEnteredAt: null,
      diffStat: null,
      archivingAt: null,
      scripts: [],
    };
    const session = {
      ...initial,
      workspaces: new Map([[current.id, current]]),
      hasHydratedAgents: true,
      hasHydratedWorkspaces: true,
    };
    const select = createEnvironmentWorkspaceVisibilitySelector({
      serverId,
      workspaceId: "current",
    });
    const before = select({ sessions: { [serverId]: session } });
    expect(before.foreignAgentIds).toEqual(new Set());
    const foreign = makeAgent({ id: "foreign", workspaceId: "other", cwd: "/other" });
    const next = { ...session, agentDetails: new Map([[foreign.id, foreign]]) };
    const after = select({ sessions: { [serverId]: next } });
    expect(after.foreignAgentIds).toEqual(new Set([foreign.id]));
    expect(select({ sessions: { [serverId]: next } })).toBe(after);
    const loading = { ...next, hasHydratedWorkspaces: false };
    expect(select({ sessions: { [serverId]: loading } }).foreignAgentIds).toEqual(new Set());
    expect(select({ sessions: { [serverId]: next } }).foreignAgentIds).toEqual(
      new Set([foreign.id]),
    );
  } finally {
    useSessionStore.getState().clearSession(serverId);
  }
});

function visibilityWorkspace(
  id: string,
  owner?: { serverId: string; workspaceId: string },
): WorkspaceDescriptor {
  return {
    id,
    createdAt: null,
    lastUserMessageAt: null,
    projectId: "project",
    projectDisplayName: "Repo",
    projectRootPath: "/repo",
    workspaceDirectory: `/${id}`,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: id,
    status: "done",
    statusEnteredAt: null,
    diffStat: null,
    archivingAt: null,
    scripts: [],
    ...(owner
      ? { projectMembership: { key: "project", name: "Project", environmentOwner: owner } }
      : {}),
  };
}

it.each(["missing-owner", "undiscovered-companion"] as const)(
  "preserves unknown group membership during %s",
  (scenario) => {
    const current = visibilityWorkspace("current");
    const destination = visibilityWorkspace("destination", {
      serverId: "host",
      workspaceId: current.id,
    });
    const foreign = makeAgent({
      id: "unknown-owner",
      workspaceId: "not-yet-loaded",
      cwd: "/other",
    });
    const ready = {
      agents: new Map([[foreign.id, foreign]]),
      agentDetails: new Map<string, Agent>(),
      workspaces: new Map([
        [current.id, current],
        [destination.id, destination],
      ]),
      hasHydratedAgents: true,
      hasHydratedWorkspaces: true,
    };
    const sessions: Parameters<typeof deriveEnvironmentWorkspaceAgentVisibility>[0]["sessions"] =
      scenario === "missing-owner"
        ? { destination: { ...ready, workspaces: new Map([[destination.id, destination]]) } }
        : {
            host: ready,
            destination: {
              ...ready,
              workspaces: new Map<string, WorkspaceDescriptor>(),
              hasHydratedWorkspaces: false,
            },
          };
    const visibility = deriveEnvironmentWorkspaceAgentVisibility({
      serverId: scenario === "missing-owner" ? "destination" : "host",
      workspaceId: scenario === "missing-owner" ? destination.id : current.id,
      sessions,
    });
    expect(visibility.foreignAgentIds).toEqual(new Set());
  },
);

it("does not classify archived or detail-only group members as foreign", () => {
  const current = visibilityWorkspace("current");
  const member = visibilityWorkspace("member", { serverId: "host", workspaceId: current.id });
  const archived = makeAgent({
    id: "archived-member",
    workspaceId: member.id,
    cwd: "/member",
    archivedAt: new Date(1),
  });
  const detailed = makeAgent({ id: "detail-member", workspaceId: member.id, cwd: "/member" });
  const foreign = makeAgent({ id: "foreign", workspaceId: "other", cwd: "/other" });
  const visibility = deriveEnvironmentWorkspaceAgentVisibility({
    serverId: "host",
    workspaceId: current.id,
    sessions: {
      host: {
        agents: new Map([
          [archived.id, archived],
          [foreign.id, foreign],
        ]),
        agentDetails: new Map([[detailed.id, detailed]]),
        workspaces: new Map([
          [current.id, current],
          [member.id, member],
        ]),
        hasHydratedAgents: true,
        hasHydratedWorkspaces: true,
      },
    },
  });
  expect(visibility.foreignAgentIds).toEqual(new Set([foreign.id]));
  expect(visibility.activeAgentIds.has(archived.id)).toBe(false);
});
