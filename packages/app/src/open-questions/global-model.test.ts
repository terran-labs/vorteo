import type { StreamItem } from "@/types/stream";
import { fetchedWindowCovers, findItemAtOrBefore } from "@/agent-stream/jump-position";
import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import { expect, test } from "vitest";
import {
  MAX_ACCEPT_LINES,
  visibleText,
  collectThreadApprovals,
  collectThreadQuestions,
  globalOpenQuestionCount,
  type QuestionHostInput,
} from "./global-model";

function question(id: string, overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id,
    question: `Question ${id}`,
    why: "It blocks the release.",
    recommendedDefault: "Ship tomorrow",
    askedAt: "2026-10-18T10:00:00.000Z",
    askedBy: "agent",
    status: "open",
    ...overrides,
  };
}

const workspaces = new Map([
  ["w1", { name: "main", title: null, projectDisplayName: "Vorteo", projectCustomName: null }],
  [
    "w2",
    {
      name: "Solon",
      title: "Brand",
      projectDisplayName: "Solon",
      projectCustomName: "Solon Energy",
    },
  ],
]);

function host(
  serverId: string,
  agents: QuestionHostInput["agents"],
  pendingArchive: ReadonlySet<string> = new Set(),
): QuestionHostInput {
  return { serverId, hostLabel: serverId.toUpperCase(), agents, workspaces, pendingArchive };
}

test("lists only open questions from active threads, labeled by project", () => {
  const threads = collectThreadQuestions([
    host(
      "host",
      [
        {
          id: "a",
          title: "Fix cards",
          workspaceId: "w1",
          archivedAt: null,
          questions: [question("q1"), question("q2", { status: "answered", answer: "No" })],
        },
        {
          id: "b",
          title: "Old",
          workspaceId: "w1",
          archivedAt: new Date(),
          questions: [question("q3")],
        },
        {
          id: "c",
          title: "Leaving",
          workspaceId: "w1",
          archivedAt: null,
          questions: [question("q4")],
        },
        { id: "d", title: "Quiet", workspaceId: "w1", archivedAt: null, questions: [] },
        { id: "e", title: "  ", workspaceId: "w2", archivedAt: null, questions: [question("q5")] },
      ],
      new Set(["c"]),
    ),
  ]);
  expect(
    threads.map((thread) => [thread.agentId, thread.questions.map((item) => item.id)]),
  ).toEqual([
    ["a", ["q1"]],
    ["e", ["q5"]],
  ]);
  expect(threads[0]).toMatchObject({ threadTitle: "Fix cards", projectLabel: "Vorteo · main" });
  expect(threads[1]).toMatchObject({
    threadTitle: "Untitled thread",
    projectLabel: "Solon Energy · Brand",
  });
  expect(threads.every((thread) => thread.hostLabel === null)).toBe(true);
  expect(globalOpenQuestionCount(threads)).toBe(2);
});

test("puts threads blocking the most tasks first, then the longest waiting", () => {
  const threads = collectThreadQuestions([
    host("host", [
      {
        id: "recent",
        title: "Recent",
        workspaceId: "w1",
        archivedAt: null,
        questions: [question("r", { askedAt: "2026-10-19T10:00:00.000Z" })],
      },
      {
        id: "blocking",
        title: "Blocking",
        workspaceId: "w1",
        archivedAt: null,
        questions: [question("b", { blocks: ["t1", "t2"], askedAt: "2026-10-20T10:00:00.000Z" })],
      },
      {
        id: "waiting",
        title: "Waiting",
        workspaceId: "w1",
        archivedAt: null,
        questions: [question("w", { askedAt: "2026-10-17T10:00:00.000Z" })],
      },
    ]),
  ]);
  expect(threads.map((thread) => thread.agentId)).toEqual(["blocking", "waiting", "recent"]);
});

test("names hosts only when questions come from more than one", () => {
  const thread = (id: string) => ({
    id,
    title: id,
    workspaceId: "w1",
    archivedAt: null,
    questions: [question(id)],
  });
  const threads = collectThreadQuestions([host("host", [thread("a")]), host("dev", [thread("b")])]);
  expect(threads.map((item) => item.hostLabel).sort()).toEqual(["DEV", "HOST"]);
  expect(new Set(threads.map((item) => item.key)).size).toBe(2);
});

test("counts an installation update that waits for the owner, but not one in progress", () => {
  const upgrade = {
    id: "0b6c9f4e-6c39-4e6e-9f6e-7a5d3c2b1a00",
    revision: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    release: "release-26.10.3002",
    sourceCommit: "a".repeat(40),
    previousCommit: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    status: "pending" as const,
    detail: "",
    steps: [],
  };
  const threads = collectThreadQuestions([
    host("host", [
      { id: "a", title: "A", workspaceId: "w1", archivedAt: null, questions: [question("q1")] },
    ]),
  ]);
  expect(globalOpenQuestionCount(threads, { kind: "question", upgrade })).toBe(2);
  expect(globalOpenQuestionCount([], { kind: "notice", upgrade })).toBe(1);
  expect(globalOpenQuestionCount(threads, { kind: "progress", upgrade })).toBe(1);
});

// #660: "Open" in the global card lands on the question it belongs to, not the latest message.
test("opening a question targets that question and where it was asked", async () => {
  const { openConversationTarget, useConversationTargetStore } =
    await import("./conversation-target");
  const navigations: unknown[] = [];
  const navigate = (input: unknown) => navigations.push(input);
  const first = openConversationTarget(
    { serverId: "host", agentId: "lead", kind: "question", id: "q-1", seq: 40, epoch: "e1" },
    navigate,
  );
  const second = openConversationTarget(
    { serverId: "host", agentId: "lead", kind: "question", id: "q-2", seq: 72, epoch: "e1" },
    navigate,
  );
  expect(navigations).toEqual([
    { serverId: "host", agentId: "lead" },
    { serverId: "host", agentId: "lead" },
  ]);
  // Each question carries its own id and position; the latest open wins.
  expect(useConversationTargetStore.getState().target).toEqual({
    serverId: "host",
    agentId: "lead",
    kind: "question",
    id: "q-2",
    seq: 72,
    epoch: "e1",
    requestId: second.requestId,
    expiresAt: second.expiresAt,
  });
  expect(second.requestId).not.toBe(first.requestId);
  useConversationTargetStore.getState().clear(second.requestId);
});

// #659 part C: a pending approval reaches the owner's card when no supervising thread can answer
// it. The creator is the daemon-recorded one; the parent label is ignored. A worker's creator is
// watching it unless the case says otherwise.
const ESCALATED = [
  {
    id: "perm-1",
    provider: "claude",
    name: "Bash",
    kind: "tool",
    input: { command: "ls" },
    metadata: { ownerEscalated: true },
  },
];
const PLAN = [{ id: "plan-1", provider: "claude", name: "ExitPlanMode", kind: "plan", input: {} }];
test.each([
  ["a thread the owner started", { createdByAgentId: null }, [], true],
  ["a worker whose creator can answer", { createdByAgentId: "lead" }, [], false],
  ["a worker that cleared its parent label", { createdByAgentId: "lead", labels: {} }, [], false],
  ["a worker whose creator is archived", { createdByAgentId: "lead" }, ["archived"], true],
  ["a worker whose creator is closed", { createdByAgentId: "lead" }, ["closed"], true],
  ["a worker whose creator is missing", { createdByAgentId: "gone" }, [], true],
  ["a worker whose creator is itself waiting", { createdByAgentId: "lead" }, ["waiting"], true],
  [
    "a worker whose waiting creator has a live creator",
    { createdByAgentId: "lead" },
    ["waiting", "lead-has-live-creator"],
    false,
  ],
  // A live creator that holds no finish subscription for the worker is never told.
  [
    "a worker whose live creator is not watching it",
    { createdByAgentId: "lead", permissionWatchedByCreator: false },
    [],
    true,
  ],
  // Waiting past the daemon's bound reaches the owner whoever the creator is.
  [
    "a worker waiting too long on a watching creator",
    { createdByAgentId: "lead", pendingPermissions: ESCALATED },
    [],
    true,
  ],
  [
    "a plan approval from a thread nobody created",
    { createdByAgentId: null, pendingPermissions: PLAN },
    [],
    true,
  ],
] as const)("an approval from %s reaches the owner: %s", (_label, worker, leadState, expected) => {
  const pending = {
    id: "perm-1",
    provider: "claude",
    name: "Bash",
    kind: "tool",
    input: { command: "rm -rf build" },
  } as const;
  const agents = [
    {
      id: "worker",
      title: "Worker",
      workspaceId: "w1",
      archivedAt: null,
      questions: [],
      status: "running",
      pendingPermissions: [pending],
      permissionWatchedByCreator: true,
      ...worker,
    },
    {
      id: "lead",
      title: "Lead",
      workspaceId: "w1",
      archivedAt: (leadState as readonly string[]).includes("archived") ? new Date() : null,
      questions: [],
      status: (leadState as readonly string[]).includes("closed") ? "closed" : "running",
      pendingPermissions: (leadState as readonly string[]).includes("waiting")
        ? [{ ...pending, id: "perm-lead" }]
        : [],
      createdByAgentId: (leadState as readonly string[]).includes("lead-has-live-creator")
        ? "root"
        : null,
      permissionWatchedByCreator: (leadState as readonly string[]).includes(
        "lead-has-live-creator",
      ),
    },
    {
      id: "root",
      title: "Root",
      workspaceId: "w1",
      archivedAt: null,
      questions: [],
      status: "idle",
    },
  ];
  const approvals = collectThreadApprovals([
    { ...host("host", agents as never), approvalsSupported: true },
  ]).filter((approval) => approval.agentId === "worker");
  expect(approvals.length === 1).toBe(expected);
  // A host that does not record creators shows no approvals at all, as before.
  expect(collectThreadApprovals([host("host", agents as never)])).toEqual([]);
});

// #660 review: a position means something only in its own timeline epoch, and only where the
// loaded items around it are contiguous. Anything else must fetch or report "not found".
test("a jump never matches another epoch or lands across an unloaded gap", () => {
  const item = (id: string, epoch: string, seq: number) =>
    ({ id, timelineCursor: { epoch, seq } }) as unknown as StreamItem;
  // The timeline was rebuilt: the same sequence number now names an unrelated item.
  const rebuilt = [item("other", "e2", 40), item("later", "e2", 50)];
  expect(findItemAtOrBefore(rebuilt, "e1", 42, true)).toBeNull();
  expect(
    fetchedWindowCovers({ epoch: "e2", entries: [{ seqStart: 1 }] }, { epoch: "e1", seq: 42 }),
  ).toBe(false);
  // Older history ends at 30 and the live tail starts at 60: 42 sits in the gap, so fetch.
  const head = [item("old", "e1", 20), item("older-end", "e1", 30)];
  expect(findItemAtOrBefore(head, "e1", 42)).toBeNull();
  const tail = [item("live", "e1", 60)];
  expect(findItemAtOrBefore(tail, "e1", 42, true)).toBeNull();
  // A fetched window around 42 covers it; one that starts after it does not.
  expect(
    fetchedWindowCovers({ epoch: "e1", entries: [{ seqStart: 35 }] }, { epoch: "e1", seq: 42 }),
  ).toBe(true);
  expect(
    fetchedWindowCovers({ epoch: "e1", entries: [{ seqStart: 43 }] }, { epoch: "e1", seq: 42 }),
  ).toBe(false);
  // Contiguous: the item ending at or just before 42, with the range reaching past it.
  expect(
    findItemAtOrBefore([...head, item("asked", "e1", 41), item("next", "e1", 45)], "e1", 42)?.id,
  ).toBe("asked");
});

// #659 second review: the card must not show a command differently from what runs.
test.each([
  [
    "a bidirectional override",
    "echo safe\u202E\u2066fr- mr\u2069",
    "echo safe⟨U+202E⟩⟨U+2066⟩fr- mr⟨U+2069⟩",
  ],
  ["a zero-width space", "r\u200Bm -rf x", "r⟨U+200B⟩m -rf x"],
  ["a carriage return", "ls\rrm -rf x", "ls⟨U+000D⟩rm -rf x"],
  ["newlines and tabs", "ls\n\tpwd", "ls\n\tpwd"],
])("%s shows as visible escapes", (_label, command, shown) => {
  expect(visibleText(command)).toBe(shown);
  expect(MAX_ACCEPT_LINES).toBe(200);
});
