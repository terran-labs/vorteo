import { expect, it } from "vitest";
import type { QueueItem } from "@getpaseo/protocol/message-queue";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { classifyQueueAcceptance, findQueueAcceptanceEvidence } from "./evidence.js";

const item: QueueItem = {
  id: "client-message",
  revision: 2,
  text: "Repeat this",
  attachments: [],
  createdAt: "2026-09-17T00:00:00Z",
  delivery: {
    status: "uncertain",
    attemptId: "attempt",
    startedAt: "2026-09-17T00:01:00Z",
    reason: "Restart",
  },
};
const echo: AgentStreamEvent = {
  type: "timeline",
  provider: "codex",
  turnId: "turn",
  timestamp: "2026-09-17T00:01:02Z",
  item: {
    type: "user_message",
    messageId: "native-message",
    clientMessageId: item.id,
    text: item.text,
  },
};

it("accepts a unique stable identity and tolerates repeated observations of it", () => {
  expect(findQueueAcceptanceEvidence(item, undefined, [echo, echo])).toEqual({
    turnId: "turn",
    providerMessageId: "native-message",
    acceptedAt: "2026-09-17T00:01:02Z",
  });
});

it("requires identity, never repeated text, and rejects competing provider messages", () => {
  const sameText: AgentStreamEvent = {
    type: "timeline",
    provider: "codex",
    turnId: "turn",
    item: { type: "user_message", text: item.text, messageId: "unrelated" },
  };
  expect(findQueueAcceptanceEvidence(item, undefined, [sameText])).toBeNull();
  expect(findQueueAcceptanceEvidence(item, "unrelated", [sameText])).toMatchObject({
    providerMessageId: "unrelated",
  });
  const duplicate: AgentStreamEvent = {
    type: "timeline",
    provider: "codex",
    turnId: "other-turn",
    item: {
      type: "user_message",
      text: item.text,
      messageId: "other-native",
      clientMessageId: item.id,
    },
  };
  expect(findQueueAcceptanceEvidence(item, undefined, [echo, duplicate])).toBeNull();
  expect(
    findQueueAcceptanceEvidence({ ...item, delivery: { status: "queued" } }, undefined, [echo]),
  ).toBeNull();
});

it("accepts a unique timestamped text match when the transcript keeps no client ID", () => {
  // A Claude transcript row: no clientMessageId, and the provider ID was never recorded.
  const transcript = (messageId: string, timestamp: string): AgentStreamEvent => ({
    type: "timeline",
    provider: "claude",
    turnId: `turn-${messageId}`,
    timestamp,
    item: { type: "user_message", text: item.text, messageId },
  });
  const delivered = transcript("native-1", "2026-09-17T00:01:03Z");
  expect(classifyQueueAcceptance(item, undefined, [delivered])).toEqual({
    kind: "accepted",
    evidence: {
      turnId: "turn-native-1",
      providerMessageId: "native-1",
      acceptedAt: "2026-09-17T00:01:03Z",
    },
  });
  // Text sent before the attempt started is an earlier message, not this delivery.
  const earlier = transcript("native-0", "2026-09-17T00:00:30Z");
  expect(classifyQueueAcceptance(item, undefined, [earlier])).toEqual({ kind: "none" });
  // Two candidates, by text or by identity, need the owner's review rather than a guess.
  const again = transcript("native-2", "2026-09-17T00:02:00Z");
  expect(classifyQueueAcceptance(item, undefined, [delivered, again])).toEqual({
    kind: "ambiguous",
  });
  const otherIdentified: AgentStreamEvent = {
    ...echo,
    turnId: "other-turn",
    item: { ...echo.item, messageId: "other-native" } as typeof echo.item,
  };
  expect(classifyQueueAcceptance(item, undefined, [echo, otherIdentified])).toEqual({
    kind: "ambiguous",
  });
});
