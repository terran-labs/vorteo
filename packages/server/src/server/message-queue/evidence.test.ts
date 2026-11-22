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

it("needs identity for untimestamped rows and rejects competing provider messages", () => {
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

it("accepts text only as the next user turn within the bound, for text-only items", () => {
  // Claude transcript rows: no clientMessageId, and the provider ID was never recorded.
  const row = (messageId: string, timestamp: string, text = item.text): AgentStreamEvent => ({
    type: "timeline",
    provider: "claude",
    turnId: `turn-${messageId}`,
    timestamp,
    item: { type: "user_message", text, messageId },
  });
  const delivered = row("native-1", "2026-09-17T00:01:03Z");
  expect(classifyQueueAcceptance(item, undefined, [delivered])).toEqual({
    kind: "accepted",
    evidence: {
      turnId: "turn-native-1",
      providerMessageId: "native-1",
      acceptedAt: "2026-09-17T00:01:03Z",
    },
  });
  // An attachment or context the row does not show could have been dropped: not evidence.
  const image = { id: "image", fileName: "shot.png", mimeType: "image/png", size: 1 };
  expect(
    classifyQueueAcceptance({ ...item, attachments: [image] }, undefined, [delivered]),
  ).toEqual({ kind: "none" });
  // Another user turn came first, so the identical text later is a different message.
  const other = row("native-0", "2026-09-17T00:01:02Z", "Something else");
  expect(classifyQueueAcceptance(item, undefined, [other, delivered])).toEqual({ kind: "none" });
  // Identical text typed long after the attempt is not this delivery.
  const days = row("native-9", "2026-09-25T00:01:03Z");
  expect(classifyQueueAcceptance(item, undefined, [days])).toEqual({ kind: "none" });
  // Text sent before the attempt started is an earlier message.
  const earlier = row("native-e", "2026-09-17T00:00:30Z");
  expect(classifyQueueAcceptance(item, undefined, [earlier])).toEqual({ kind: "none" });
  // Two identity matches need the owner's review rather than a guess.
  const otherIdentified: AgentStreamEvent = {
    ...echo,
    turnId: "other-turn",
    item: { ...echo.item, messageId: "other-native" } as typeof echo.item,
  };
  expect(classifyQueueAcceptance(item, undefined, [echo, otherIdentified])).toEqual({
    kind: "ambiguous",
  });
});
