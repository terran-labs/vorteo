import type { StreamItem } from "@/types/stream";
import { fetchedWindowCovers, findItemAtOrBefore } from "@/agent-stream/jump-position";
import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import { expect, test } from "vitest";
import {
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
