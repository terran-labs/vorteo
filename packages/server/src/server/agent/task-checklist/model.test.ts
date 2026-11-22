import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createChecklistTools } from "./tools.js";
import { z } from "zod";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import { AgentTaskItemSchema, type WSOutboundMessage } from "@getpaseo/protocol/messages";
import { serializeLegacyChecklistMessage } from "./compatibility.js";
import { describe, expect, test, it, vi } from "vitest";
import { ChecklistMutationSchema, mutateChecklist } from "./model.js";

describe("thread checklist mutations", () => {
  test("rejects stale editor updates and deletion without losing the agent's changes", () => {
    const original = mutateChecklist([], { operation: "create", id: "a", text: "Original" });
    const updated = mutateChecklist(original, {
      operation: "update",
      id: "a",
      text: "Agent revision",
    });
    expect(() =>
      mutateChecklist(updated, {
        operation: "update",
        id: "a",
        text: "Old draft",
        expectedTask: original[0],
      }),
    ).toThrow("changed while you were editing");
    expect(() =>
      mutateChecklist(updated, { operation: "delete", id: "a", expectedTask: original[0] }),
    ).toThrow("changed while you were editing");
    expect(
      mutateChecklist(updated, {
        operation: "update",
        id: "a",
        status: "completed",
        expectedTask: updated[0],
      })[0].text,
    ).toBe("Agent revision");
  });
  test("provider IDs cannot redirect managed edits or satisfy managed dependencies", () => {
    let tasks = mutateChecklist([], { operation: "create", id: "1", text: "Managed" });
    tasks = mutateChecklist(tasks, {
      operation: "create",
      id: "2",
      text: "Dependent",
      blockedBy: ["1"],
    });
    const provider = { id: "1", text: "Native", completed: true };
    tasks = [provider, ...tasks];
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "2", status: "completed" }),
    ).toThrow("Complete dependency 1");
    tasks = mutateChecklist(tasks, { operation: "update", id: "1", text: "Managed edit" });
    expect(tasks[0]).toEqual(provider);
    expect(tasks[1].text).toBe("Managed edit");
  });
  test("merges metadata and dependency additions with Claude task semantics", () => {
    let tasks = mutateChecklist([], {
      operation: "create",
      id: "a",
      text: "A",
      metadata: { keep: true, remove: 1 },
    });
    tasks = mutateChecklist(tasks, { operation: "create", id: "b", text: "B" });
    tasks = mutateChecklist(tasks, {
      operation: "update",
      id: "a",
      metadata: { remove: null, added: "yes" },
      addBlocks: ["b"],
    });
    expect(tasks[0].metadata).toEqual({ keep: true, added: "yes" });
    expect(tasks[1].blockedBy).toEqual(["a"]);
    tasks = mutateChecklist(tasks, { operation: "update", id: "b", addBlockedBy: ["a", "a"] });
    expect(tasks[1].blockedBy).toEqual(["a"]);
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "b", addBlocks: ["missing"] }),
    ).toThrow("does not exist");
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "b", addBlocks: ["a"] }),
    ).toThrow("cycle");
  });
  test("creates a pending task with stable identity and keeps provider tasks", () => {
    const provider = { id: "1", text: "Native plan", completed: false };
    const result = mutateChecklist([provider], {
      operation: "create",
      id: "build",
      text: "Build the API",
      description: "Acceptance: clients can create tasks",
    });
    expect(result).toEqual([
      provider,
      {
        id: "build",
        source: "vorteo",
        text: "Build the API",
        description: "Acceptance: clients can create tasks",
        status: "pending",
        completed: false,
      },
    ]);
  });

  test("dependencies block execution, completion unlocks it, and reopening preserves details", () => {
    let tasks = mutateChecklist([], { operation: "create", id: "api", text: "API" });
    tasks = mutateChecklist(tasks, {
      operation: "create",
      id: "ui",
      text: "UI",
      blockedBy: ["api"],
      owner: "worker",
      metadata: { milestone: 1 },
    });
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "ui", status: "in_progress" }),
    ).toThrow("Complete dependency api");
    tasks = mutateChecklist(tasks, { operation: "update", id: "api", status: "completed" });
    tasks = mutateChecklist(tasks, { operation: "update", id: "ui", status: "completed" });
    tasks = mutateChecklist(tasks, {
      operation: "update",
      id: "ui",
      status: "pending",
      text: "UI regression",
    });
    expect(tasks[1]).toEqual({
      id: "ui",
      source: "vorteo",
      text: "UI regression",
      blockedBy: ["api"],
      owner: "worker",
      metadata: { milestone: 1 },
      status: "pending",
      completed: false,
    });
  });

  test("rejects cycles and missing dependencies without modifying the input", () => {
    const first = mutateChecklist([], { operation: "create", id: "a", text: "A" });
    const tasks = mutateChecklist(first, {
      operation: "create",
      id: "b",
      text: "B",
      blockedBy: ["a"],
    });
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "a", blockedBy: ["b"] }),
    ).toThrow("must not form a cycle");
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "b", blockedBy: ["missing"] }),
    ).toThrow("does not exist");
    expect(tasks[0]).toEqual(first[0]);
    expect(tasks[1].blockedBy).toEqual(["a"]);
  });

  test("deletes dependency edges and reorders without dropping provider tasks", () => {
    const provider = { id: "native", text: "Native plan", completed: true };
    let tasks = mutateChecklist([provider], { operation: "create", id: "a", text: "A" });
    tasks = mutateChecklist(tasks, { operation: "create", id: "b", text: "B", blockedBy: ["a"] });
    tasks = mutateChecklist(tasks, { operation: "reorder", ids: ["b", "a"] });
    expect(tasks.map((task) => task.id)).toEqual(["native", "b", "a"]);
    tasks = mutateChecklist(tasks, { operation: "delete", id: "a" });
    expect(tasks).toEqual([
      provider,
      { id: "b", text: "B", source: "vorteo", status: "pending", completed: false, blockedBy: [] },
    ]);
    expect(() => mutateChecklist(tasks, { operation: "delete", id: "native" })).toThrow(
      "native provider task tool",
    );
    expect(() => mutateChecklist(tasks, { operation: "reorder", ids: ["b", "b"] })).toThrow(
      "exactly once",
    );
    expect(() =>
      mutateChecklist(tasks, { operation: "create", id: "b", text: "Duplicate" }),
    ).toThrow("already exists");
  });
});

test("wake conditions round-trip optionally, clear explicitly and protect expected snapshots", async () => {
  const legacy = { text: "Old task", completed: false };
  expect(AgentTaskItemSchema.parse(legacy)).toEqual(legacy);
  const condition = { kind: "deadline", at: "2026-11-18T20:00:00Z" } as const;
  const created = mutateChecklist(
    [],
    ChecklistMutationSchema.parse({
      operation: "create",
      id: "wake",
      text: "Wait",
      wakeCondition: condition,
    }),
  );
  expect(AgentTaskItemSchema.parse(JSON.parse(JSON.stringify(created[0])))).toEqual(created[0]);
  expect(created[0].wakeCondition).toEqual(condition);
  const { wakeCondition: _condition, ...oldSnapshot } = created[0];
  expect(AgentTaskItemSchema.omit({ wakeCondition: true }).parse(created[0])).toEqual(oldSnapshot);
  expect(
    mutateChecklist(created, { operation: "update", id: "wake", text: "Renamed" })[0].wakeCondition,
  ).toEqual(condition);
  for (const operation of ["update", "delete"] as const) {
    expect(() =>
      mutateChecklist(created, {
        operation,
        id: "wake",
        expectedTask: oldSnapshot,
      }),
    ).toThrow("changed while");
  }
  const cleared = mutateChecklist(
    created,
    ChecklistMutationSchema.parse({
      operation: "update",
      id: "wake",
      expectedTask: created[0],
      wakeCondition: null,
    }),
  );
  expect(cleared[0]).toEqual(oldSnapshot);
  expect(
    mutateChecklist([], { operation: "create", text: "No condition", wakeCondition: null })[0],
  ).not.toHaveProperty("wakeCondition");
  expect(() =>
    mutateChecklist([{ ...created[0], source: "provider" }], {
      operation: "update",
      id: "wake",
      wakeCondition: null,
    }),
  ).toThrow("native provider task tool");
  const targets = [
    {
      kind: "github_pull_request",
      owner: "example",
      repository: "repo",
      number: 1,
      state: "merged",
    },
    { kind: "github_workflow_run", owner: "example", repository: "repo", runId: 2, attempt: 1 },
    {
      kind: "github_required_checks",
      owner: "example",
      repository: "repo",
      number: 1,
      headSha: "a".repeat(40),
      checks: ["build"],
    },
  ];
  for (const wakeCondition of targets) {
    const updated = mutateChecklist(
      created,
      ChecklistMutationSchema.parse({
        operation: "update",
        id: "wake",
        wakeCondition,
      }),
    );
    expect(AgentTaskItemSchema.parse(updated[0]).wakeCondition).toEqual(wakeCondition);
  }
  for (const wakeCondition of [
    { ...condition, at: "2026-02-30T00:00:00Z" },
    { ...targets[0], owner: "https://example.com" },
    { ...targets[1], attempt: 0 },
    { ...targets[2], headSha: "abc" },
    { ...targets[2], checks: [] },
  ]) {
    const mutation = ChecklistMutationSchema.parse({
      operation: "update",
      id: "wake",
      wakeCondition,
    });
    expect(() => mutateChecklist(created, mutation)).toThrow();
  }
  const directory = mkdtempSync(join(tmpdir(), "wake-wire-"));
  const storage = new AgentStorage(directory, createTestLogger());
  try {
    await storage.upsert({
      id: "thread",
      provider: "codex",
      cwd: directory,
      createdAt: condition.at,
      updatedAt: condition.at,
      labels: {},
      lastStatus: "idle",
    });
    await expect(
      storage.mutateChecklist("thread", {
        operation: "create",
        id: "task",
        text: "Wait",
        wakeCondition: condition,
      }),
    ).rejects.toThrow("monitoring is unavailable");
    await storage.mutateChecklist("thread", { operation: "create", id: "task", text: "Wait" });
    await expect(
      storage.mutateChecklist("thread", {
        operation: "update",
        id: "task",
        wakeCondition: condition,
      }),
    ).rejects.toThrow("monitoring is unavailable");
    // Readiness may disappear while a mutation awaits the store's serialized write.
    let ready = true;
    const pending = storage.mutateChecklist(
      "thread",
      {
        operation: "update",
        id: "task",
        wakeCondition: condition,
      },
      () => ready,
    );
    ready = false;
    await expect(pending).rejects.toThrow("monitoring is unavailable");
    const ordinary = await storage.mutateChecklist("thread", {
      operation: "update",
      id: "task",
      text: "Still editable",
      wakeCondition: null,
    });
    expect(ordinary[0]).toMatchObject({ text: "Still editable" });
    expect(ordinary[0]).not.toHaveProperty("wakeCondition");
  } finally {
    await storage.flush();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("blocked is discretionary, incomplete, and independent of prerequisite edges", () => {
  let tasks = mutateChecklist([], {
    operation: "create",
    id: "a",
    text: "Waiting for review",
    owner: "worker",
    description: "Review accepted",
    metadata: { keep: true },
  });
  for (const status of [
    "in_progress",
    "blocked",
    "pending",
    "blocked",
    "completed",
    "blocked",
  ] as const) {
    tasks = mutateChecklist(
      tasks,
      ChecklistMutationSchema.parse({ operation: "update", id: "a", status }),
    );
    expect(tasks[0]).toMatchObject({
      status,
      completed: status === "completed",
      owner: "worker",
      description: "Review accepted",
      metadata: { keep: true },
    });
    expect(tasks[0].blockedBy).toBeUndefined();
  }
  tasks = mutateChecklist(tasks, {
    operation: "create",
    id: "b",
    text: "Dependent",
    blockedBy: ["a"],
  });
  tasks = mutateChecklist(tasks, { operation: "update", id: "b", status: "blocked" });
  expect(() =>
    mutateChecklist(tasks, { operation: "update", id: "b", status: "in_progress" }),
  ).toThrow("Complete dependency a");
  tasks = mutateChecklist(tasks, { operation: "update", id: "a", status: "completed" });
  expect(tasks[1].status).toBe("blocked");
  tasks = mutateChecklist(tasks, { operation: "update", id: "b", status: "in_progress" });
  expect(tasks[1]).toMatchObject({ status: "in_progress", completed: false, blockedBy: ["a"] });
});

test("legacy serialization downgrades checklist status without touching metadata or source state", () => {
  const arbitrary = { text: "Payload", status: "blocked", completed: false };
  const task: AgentTaskItem = {
    id: "a",
    text: "Waiting",
    status: "blocked",
    completed: false,
    metadata: { arbitrary },
  };
  const message: WSOutboundMessage = {
    type: "session",
    message: {
      type: "agent_stream",
      payload: {
        agentId: "a",
        timestamp: new Date().toISOString(),
        event: { type: "timeline", provider: "codex", item: { type: "todo", items: [task] } },
      },
    },
  };
  const encoded = JSON.parse(serializeLegacyChecklistMessage(message));
  const legacyTask = encoded.message.payload.event.item.items[0];
  expect(legacyTask).toEqual({ ...task, status: "pending" });
  expect(legacyTask.metadata.arbitrary.status).toBe("blocked");
  expect(task.status).toBe("blocked");
  expect(
    AgentTaskItemSchema.extend({
      status: z.enum(["pending", "in_progress", "completed"]).optional(),
    }).safeParse(legacyTask).success,
  ).toBe(true);
});

test("Review stays incomplete, retains dependencies and cannot be edited through a legacy projection", () => {
  let tasks = mutateChecklist([], { operation: "create", id: "approval", text: "Approve" });
  tasks = mutateChecklist(tasks, {
    operation: "create",
    id: "delivery",
    text: "Deliver",
    blockedBy: ["approval"],
  });
  tasks = mutateChecklist(
    tasks,
    ChecklistMutationSchema.parse({ operation: "update", id: "approval", status: "review" }),
  );
  expect(tasks[0]).toMatchObject({ status: "review", completed: false });
  expect(() =>
    mutateChecklist(tasks, { operation: "update", id: "delivery", status: "in_progress" }),
  ).toThrow("Complete dependency");
  const message: WSOutboundMessage = {
    type: "session",
    message: {
      type: "agent.checklist.get.response",
      payload: { agentId: "agent", requestId: "request", tasks, error: null },
    },
  };
  const projected = JSON.parse(
    serializeLegacyChecklistMessage(message, undefined, { blocked: true, review: false }),
  );
  const legacy = projected.message.payload.tasks[0];
  expect(legacy).toMatchObject({ status: "pending", completed: false });
  expect(() =>
    mutateChecklist(tasks, {
      operation: "update",
      id: "approval",
      expectedTask: legacy,
      status: "completed",
    }),
  ).toThrow("changed while");
  expect(
    JSON.parse(serializeLegacyChecklistMessage(message, undefined, { blocked: true, review: true }))
      .message.payload.tasks[0].status,
  ).toBe("review");
  expect(tasks[0].status).toBe("review");
});

describe("checklist progress", () => {
  const created = mutateChecklist([], { operation: "create", id: "a", text: "Ship it" });
  const update = (
    items: AgentTaskItem[],
    fields: Omit<
      Extract<z.infer<typeof ChecklistMutationSchema>, { operation: "update" }>,
      "operation" | "id"
    >,
  ) => mutateChecklist(items, { operation: "update", id: "a", ...fields })[0];

  test("accepts edits from apps that predate progress and keeps other conflicts", () => {
    const tracked = mutateChecklist(created, {
      operation: "update",
      id: "a",
      checks: [
        { text: "One", done: true },
        { text: "Two", done: false },
      ],
    });
    // An older app parses items without progress and checks, so its expectedTask lacks them.
    const { progress: _progress, checks: _checks, ...legacyView } = tracked[0];
    const renamed = mutateChecklist(tracked, {
      operation: "update",
      id: "a",
      text: "Renamed",
      expectedTask: legacyView,
    });
    expect(renamed[0]).toMatchObject({ text: "Renamed", progress: 50, checks: tracked[0].checks });
    expect(() =>
      mutateChecklist(renamed, {
        operation: "update",
        id: "a",
        text: "Stale rename",
        expectedTask: legacyView,
      }),
    ).toThrow("changed while you were editing");
    // A client that sends progress fields still has them compared.
    expect(() =>
      mutateChecklist(renamed, {
        operation: "update",
        id: "a",
        text: "Stale progress",
        expectedTask: { ...renamed[0], progress: 10 },
      }),
    ).toThrow("changed while you were editing");
  });

  test("rounds estimates to five points and caps unfinished work at 90", () => {
    expect(update(created, { progress: 42 }).progress).toBe(40);
    expect(update(created, { progress: 43 }).progress).toBe(45);
    expect(update(created, { progress: 100 }).progress).toBe(90);
  });

  test("derives progress from passed checks and ignores a conflicting estimate", () => {
    const task = update(created, {
      progress: 10,
      checks: [
        { text: "Schema accepts progress", done: true },
        { text: "Old clients still parse", done: true },
        { text: "Sidebar shows partial credit", done: false },
      ],
    });
    expect(task.progress).toBe(65);
  });

  test("keeps all-passed checks below done until the item is completed", () => {
    const checks = [{ text: "Only check", done: true }];
    expect(update(created, { checks }).progress).toBe(90);
    expect(update(created, { checks, status: "completed" }).progress).toBe(100);
    expect(update(created, { status: "completed" })).not.toHaveProperty("progress");
  });

  test("completion means 100 and a parked item keeps its partial progress", () => {
    const started = mutateChecklist(created, {
      operation: "update",
      id: "a",
      status: "in_progress",
      progress: 60,
    });
    expect(update(started, { status: "pending" }).progress).toBe(60);
    expect(update(started, { status: "completed" }).progress).toBe(100);
  });

  test("creates with progress settled from the same rules", () => {
    const [task] = mutateChecklist([], {
      operation: "create",
      id: "b",
      text: "Estimate",
      progress: 97,
    });
    expect(task.progress).toBe(90);
  });

  test("older checklist items without progress stay unchanged", () => {
    expect(update(created, { text: "Renamed" })).not.toHaveProperty("progress");
  });

  test("the wire schema accepts progress and checks while older items still parse", () => {
    expect(AgentTaskItemSchema.parse({ text: "Old", completed: false })).toEqual({
      text: "Old",
      completed: false,
    });
    expect(
      AgentTaskItemSchema.parse({
        text: "New",
        completed: false,
        progress: 65,
        checks: [{ text: "Check", done: true }],
      }),
    ).toMatchObject({ progress: 65, checks: [{ text: "Check", done: true }] });
  });
});

describe("checklist progress review follow-ups", () => {
  const created = mutateChecklist([], { operation: "create", id: "a", text: "Ship it" });
  const update = (
    items: AgentTaskItem[],
    fields: Omit<
      Extract<z.infer<typeof ChecklistMutationSchema>, { operation: "update" }>,
      "operation" | "id"
    >,
  ) => mutateChecklist(items, { operation: "update", id: "a", ...fields });

  test("refuses completion while an acceptance check has not passed", () => {
    const checked = update(created, { checks: [{ text: "Tests pass", done: false }] });
    expect(() => update(checked, { status: "completed" })).toThrow("acceptance check");
    const passed = update(checked, { checks: [{ text: "Tests pass", done: true }] });
    expect(update(passed, { status: "completed" })[0]).toMatchObject({
      completed: true,
      progress: 100,
    });
  });

  test("emptying checks drops their derived value, and null clears an estimate", () => {
    const checked = update(created, {
      checks: [
        { text: "A", done: true },
        { text: "B", done: false },
      ],
    });
    expect(checked[0].progress).toBe(50);
    const cleared = update(checked, { checks: [] })[0];
    expect(cleared).not.toHaveProperty("checks");
    expect(cleared).not.toHaveProperty("progress");
    const estimated = update(created, { progress: 40 });
    expect(update(estimated, { progress: null })[0]).not.toHaveProperty("progress");
    expect(update(checked, { checks: [], progress: 30 })[0].progress).toBe(30);
  });

  test("items completed before the rule stay editable", () => {
    const legacy: AgentTaskItem[] = [
      {
        ...created[0],
        status: "completed",
        completed: true,
        checks: [{ text: "Old", done: false }],
        progress: 100,
      },
    ];
    expect(update(legacy, { text: "Renamed" })[0].text).toBe("Renamed");
  });
});

describe("thread checklist tool projections", () => {
  it("returns only affected compact tasks and status counts", async () => {
    const tasks = [
      { id: "other", text: "Other", completed: false, source: "vorteo" as const },
      { id: "new", text: "New", completed: false, source: "vorteo" as const },
    ];
    const manager = {
      readChecklist: vi.fn(() => tasks.slice(0, 1)),
      mutateChecklist: vi.fn(async () => tasks),
    };
    const tool = createChecklistTools(manager, "thread")[1];
    const created = await tool.handler({ mutation: { operation: "create", text: "New" } }, {});
    expect(created.structuredContent).toEqual({
      task: expect.objectContaining({ id: "new" }),
      summary: { pending: 2, in_progress: 0, review: 0, blocked: 0, completed: 0 },
    });
    const updated = await tool.handler({ mutation: { operation: "update", id: "new" } }, {});
    expect(updated.structuredContent).toMatchObject({ tasks: [{ id: "new" }] });
    const deleted = await tool.handler({ mutation: { operation: "delete", id: "new" } }, {});
    expect(deleted.structuredContent).toMatchObject({ id: "new" });
    const reordered = await tool.handler(
      { mutation: { operation: "reorder", ids: ["new", "other"] } },
      {},
    );
    expect(reordered.structuredContent).toMatchObject({ ids: ["new", "other"] });
  });

  it("returns the created Vorteo task when a provider task follows it", async () => {
    const existing: AgentTaskItem = {
      id: "existing",
      text: "Existing",
      source: "vorteo",
      completed: false,
    };
    const provider: AgentTaskItem = {
      id: "new",
      text: "Native task",
      source: "provider",
      completed: false,
    };
    const created: AgentTaskItem = {
      id: "new",
      text: "Created task",
      source: "vorteo",
      completed: false,
    };
    const manager = {
      readChecklist: vi.fn(() => [existing, provider]),
      mutateChecklist: vi.fn(async () => [existing, created, provider]),
    };
    const tool = createChecklistTools(manager, "thread")[1];
    const response = await tool.handler(
      { mutation: { operation: "create", text: "Created task" } },
      {},
    );
    expect(response.structuredContent).toEqual({
      task: { id: "new", text: "Created task", source: "vorteo", status: "pending" },
      summary: { pending: 3, in_progress: 0, review: 0, blocked: 0, completed: 0 },
    });
  });

  it("lists compact tasks while preserving full detail by id", async () => {
    const task = {
      id: "large",
      text: "Large",
      completed: false,
      description: "d".repeat(1000),
      metadata: { record: "x".repeat(86000) },
      checks: [{ text: "Check", done: true }],
    };
    const manager = { readChecklist: vi.fn(() => [task]), mutateChecklist: vi.fn(async () => []) };
    const tool = createChecklistTools(manager, "thread")[0];
    const listed = await tool.handler({}, {});
    expect(listed.structuredContent).toEqual({
      tasks: [
        {
          id: "large",
          text: "Large",
          status: "pending",
          description: "d".repeat(200),
          checks: { total: 1, done: 1 },
        },
      ],
    });
    expect(JSON.stringify(listed.structuredContent).length).toBeLessThan(1000);
    const detail = await tool.handler({ id: "large" }, {});
    expect(detail.structuredContent).toEqual({ task, blocks: [] });
  });

  it("caps merged metadata and preserves untouched legacy records", async () => {
    const base = mutateChecklist([], {
      operation: "create",
      id: "task",
      text: "Task",
      metadata: { a: "x".repeat(4000) },
    });
    expect(() =>
      mutateChecklist(base, {
        operation: "update",
        id: "task",
        metadata: { b: "界".repeat(2000) },
      }),
    ).toThrow("journal's machineContext");
    expect(() =>
      mutateChecklist([], {
        operation: "create",
        text: "Too big",
        metadata: { a: "x".repeat(8192) },
      }),
    ).toThrow("8 KiB");
    const legacy = [{ ...base[0], metadata: { a: "x".repeat(86000) } }];
    expect(
      mutateChecklist(legacy, { operation: "update", id: "task", status: "in_progress" })[0]
        .metadata,
    ).toEqual(legacy[0].metadata);
    expect(
      mutateChecklist(legacy, { operation: "update", id: "task", metadata: { a: null } })[0]
        .metadata,
    ).toEqual({});
  });
});

describe("batched checklist updates", () => {
  /** Real storage behind the tool, so atomicity is checked against what reaches disk. */
  async function batchFixture() {
    const directory = mkdtempSync(join(tmpdir(), "checklist-batch-"));
    const storage = new AgentStorage(directory, createTestLogger());
    await storage.upsert({
      id: "thread",
      provider: "codex",
      cwd: directory,
      createdAt: "2026-11-21T00:00:00Z",
      updatedAt: "2026-11-21T00:00:00Z",
      labels: {},
      lastStatus: "idle",
    });
    for (const id of ["a", "b"]) {
      await storage.mutateChecklist("thread", { operation: "create", id, text: id.toUpperCase() });
    }
    await storage.flush();
    const manager = {
      readChecklist: () => storage.getLoadedRecord("thread")?.tasks ?? [],
      mutateChecklist: vi.fn(
        (_agentId: string, input: Parameters<AgentStorage["mutateChecklist"]>[1]) =>
          storage.mutateChecklist("thread", input, () => true),
      ),
    };
    const tool = createChecklistTools(manager, "thread")[1];
    const disk = () =>
      readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => [
          join(entry.parentPath, entry.name),
          readFileSync(join(entry.parentPath, entry.name), "utf8"),
        ]);
    const state = async () => {
      const record = await storage.get("thread");
      return { tasks: record?.tasks, wake: record?.checklistWakeGenerations, files: disk() };
    };
    const cleanup = async () => {
      await storage.flush();
      rmSync(directory, { recursive: true, force: true });
    };
    return { storage, manager, tool, state, cleanup };
  }

  it.each([
    {
      name: "a missing task",
      failing: { operation: "update", id: "missing" },
      error: "Task missing does not exist.",
    },
    {
      name: "a rule violation",
      failing: { operation: "update", id: "k", status: "completed" },
      error: "Mark every acceptance check",
    },
  ] as const)("rolls back memory and disk when a middle mutation hits $name", async (row) => {
    const { storage, tool, state, cleanup } = await batchFixture();
    try {
      const before = await state();
      const mutations = [
        { operation: "create", id: "k", text: "K", checks: [{ text: "Passes", done: false }] },
        row.failing,
        { operation: "delete", id: "b" },
      ];
      await expect(tool.handler({ mutations }, {})).rejects.toThrow(
        `Mutation 2 of 3 (update ${row.failing.id}) failed, so none were applied: ${row.error}`,
      );
      await storage.flush();
      expect(await state()).toEqual(before);

      const writes = vi.spyOn(
        storage as unknown as { writeRecord: () => Promise<void> },
        "writeRecord",
      );
      await tool.handler({ mutations: [mutations[0], mutations[2]] }, {});
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it.each([
    {
      name: "create then start the same item",
      mutations: [
        { operation: "create", id: "x", text: "X" },
        { operation: "update", id: "x", status: "in_progress" },
      ],
      expected: { tasks: [expect.objectContaining({ id: "x", status: "in_progress" })] },
    },
    {
      name: "complete a prerequisite created earlier in the batch",
      mutations: [
        { operation: "create", id: "p", text: "P" },
        { operation: "create", id: "q", text: "Q", blockedBy: ["p"] },
        { operation: "update", id: "p", status: "completed" },
        { operation: "update", id: "q", status: "in_progress" },
      ],
      expected: {
        tasks: [
          expect.objectContaining({ id: "p", status: "completed" }),
          expect.objectContaining({ id: "q", status: "in_progress", blockedBy: ["p"] }),
        ],
      },
    },
    {
      name: "reorder every ID left after the batch's creates and deletes",
      mutations: [
        { operation: "create", id: "c", text: "C" },
        { operation: "delete", id: "b" },
        { operation: "reorder", ids: ["c", "a"] },
      ],
      expected: { tasks: [expect.objectContaining({ id: "c" })], deleted: ["b"], ids: ["c", "a"] },
    },
    {
      name: "a deleted item cannot be referenced later",
      mutations: [
        { operation: "delete", id: "b" },
        { operation: "update", id: "b", text: "Gone" },
      ],
      error: "Mutation 2 of 2 (update b) failed, so none were applied: Task b does not exist.",
    },
    {
      name: "a reorder must account for the batch's deletes",
      mutations: [
        { operation: "delete", id: "b" },
        { operation: "reorder", ids: ["b", "a"] },
      ],
      error: "Mutation 2 of 2 (reorder) failed",
    },
    {
      name: "a prerequisite still open in the batch blocks starting",
      mutations: [
        { operation: "create", id: "q", text: "Q", blockedBy: ["a"] },
        { operation: "update", id: "q", status: "in_progress" },
      ],
      error: "Complete dependency a",
    },
  ] as const)("sees earlier mutations in the batch: $name", async (row) => {
    const { tool, state, cleanup } = await batchFixture();
    try {
      const before = await state();
      const run = tool.handler({ mutations: row.mutations }, {});
      if ("error" in row) {
        await expect(run).rejects.toThrow(row.error);
        expect(await state()).toEqual(before);
      } else {
        expect((await run).structuredContent).toMatchObject(row.expected);
      }
    } finally {
      await cleanup();
    }
  });

  it("keeps the single-mutation request, response and errors unchanged", async () => {
    const { manager, tool, cleanup } = await batchFixture();
    try {
      const mutation = { operation: "update", id: "a", status: "in_progress" } as const;
      const response = await tool.handler({ mutation }, {});
      expect(manager.mutateChecklist).toHaveBeenLastCalledWith("thread", mutation);
      expect(response.structuredContent).toEqual({
        tasks: [{ id: "a", text: "A", source: "vorteo", status: "in_progress" }],
        summary: { pending: 1, in_progress: 1, review: 0, blocked: 0, completed: 0 },
      });
      await expect(
        tool.handler({ mutation: { operation: "update", id: "missing" } }, {}),
      ).rejects.toThrow(/^Task missing does not exist\.$/);
    } finally {
      await cleanup();
    }
  });

  it("arms a wake condition set in a batch once on commit and never on rollback", async () => {
    const { storage, tool, state, cleanup } = await batchFixture();
    try {
      const wait = {
        operation: "update",
        id: "a",
        status: "blocked",
        wakeCondition: { kind: "deadline", at: "2026-11-22T00:00:00Z" },
      } as const;
      const before = await state();
      await expect(
        tool.handler({ mutations: [wait, { operation: "update", id: "missing" }] }, {}),
      ).rejects.toThrow("Mutation 2 of 2");
      await storage.flush();
      expect(await state()).toEqual(before);

      await tool.handler(
        { mutations: [wait, { operation: "update", id: "a", text: "Waiting" }] },
        {},
      );
      const generations = (await storage.get("thread"))?.checklistWakeGenerations;
      expect(generations).toEqual([
        expect.objectContaining({ taskId: "a", condition: wait.wakeCondition }),
      ]);
    } finally {
      await cleanup();
    }
  });

  it("returns generated IDs for batch creates and validates every item before applying any", async () => {
    const { tool, state, cleanup } = await batchFixture();
    try {
      const created = await tool.handler(
        { mutation: null, mutations: [{ operation: "create", text: "Unnamed" }] },
        {},
      );
      const [task] = (created.structuredContent as { tasks: AgentTaskItem[] }).tasks;
      expect(task).toMatchObject({ text: "Unnamed", status: "pending" });
      expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
      // The loose batch declaration must refuse anything the strict mutation schema refuses.
      const before = await state();
      await expect(
        tool.handler(
          {
            mutations: [
              { operation: "create", id: "ok", text: "OK" },
              { operation: "update", id: "a", unknownField: true },
            ],
          },
          {},
        ),
      ).rejects.toThrow("Mutation 2 of 2 is invalid, so none were applied");
      expect(await state()).toEqual(before);
    } finally {
      await cleanup();
    }
  });
});
