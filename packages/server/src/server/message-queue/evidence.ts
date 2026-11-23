import type { QueueItem } from "@getpaseo/protocol/message-queue";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

/** How long an uncertain message may stay unconfirmed by history before the owner must decide. */
export const UNCONFIRMED_DELIVERY_BOUND_MS = 15 * 60_000;

export interface QueueAcceptanceEvidence {
  turnId: string | null;
  providerMessageId?: string;
  acceptedAt: string;
}

export type QueueAcceptance =
  | { kind: "accepted"; evidence: QueueAcceptanceEvidence }
  /** More than one distinct provider message could be this delivery; the owner must review. */
  | { kind: "ambiguous" }
  | { kind: "none" };

function evidenceOf(
  item: QueueItem & { delivery: { status: "uncertain" } },
  event: AgentStreamEvent & { type: "timeline" },
): [string, QueueAcceptanceEvidence] {
  const turnId = event.turnId ?? null;
  const nativeId = event.item.type === "user_message" ? event.item.messageId : undefined;
  const acceptedAt =
    event.timestamp && Number.isFinite(Date.parse(event.timestamp))
      ? event.timestamp
      : item.delivery.startedAt;
  return [
    JSON.stringify([nativeId ?? null, turnId]),
    { turnId, ...(nativeId ? { providerMessageId: nativeId } : {}), acceptedAt },
  ];
}

// Only raw provider history is evidence. An app timeline can include optimistic
// rows and daemon overlays, neither of which proves provider acceptance.
export function classifyQueueAcceptance(
  item: QueueItem,
  providerMessageId: string | undefined,
  history: readonly AgentStreamEvent[],
): QueueAcceptance {
  if (item.delivery.status !== "uncertain") return { kind: "none" };
  const uncertain = item as QueueItem & { delivery: { status: "uncertain" } };
  const identified = new Map<string, QueueAcceptanceEvidence>();
  const startedAt = Date.parse(uncertain.delivery.startedAt);
  // The earliest timestamped user message at or after the attempt started: a delivered queued
  // message is the thread's next user turn.
  let next: { at: number; event: AgentStreamEvent & { type: "timeline" } } | null = null;
  for (const event of history) {
    if (event.type !== "timeline" || event.item.type !== "user_message") continue;
    if (identifies(event.item, item.id, providerMessageId)) {
      identified.set(...evidenceOf(uncertain, event));
      continue;
    }
    const at = event.timestamp ? Date.parse(event.timestamp) : Number.NaN;
    if (Number.isFinite(at) && at >= startedAt && (!next || at < next.at)) next = { at, event };
  }
  // Repeated observations of one native message are fine. Multiple distinct
  // provider messages with the same client ID require explicit review.
  if (identified.size === 1) return { kind: "accepted", evidence: [...identified.values()][0] };
  if (identified.size > 1) return { kind: "ambiguous" };
  // Claude transcripts keep no client message ID, and the provider ID is recorded after the
  // turn starts, so a delivery cut off by a crash can carry only its text. Text is evidence
  // only for a text-only item whose identical text is the next user turn, within the bound:
  // a match with lost attachments or context, or any later turn, could drop content silently.
  if (next && isTextDelivery(item, next, startedAt))
    return { kind: "accepted", evidence: evidenceOf(uncertain, next.event)[1] };
  return { kind: "none" };
}

function identifies(
  message: { clientMessageId?: string; messageId?: string },
  itemId: string,
  providerMessageId: string | undefined,
): boolean {
  return (
    message.clientMessageId === itemId ||
    message.messageId === itemId ||
    (providerMessageId !== undefined && message.messageId === providerMessageId)
  );
}

/** A text-only item whose identical text is the next user turn, within the bound. */
function isTextDelivery(
  item: QueueItem,
  next: { at: number; event: AgentStreamEvent & { type: "timeline" } },
  startedAt: number,
): boolean {
  if (item.attachments.length > 0 || item.context?.length) return false;
  if (next.at - startedAt > UNCONFIRMED_DELIVERY_BOUND_MS) return false;
  return next.event.item.type === "user_message" && next.event.item.text === item.text;
}

export function findQueueAcceptanceEvidence(
  item: QueueItem,
  providerMessageId: string | undefined,
  history: readonly AgentStreamEvent[],
): QueueAcceptanceEvidence | null {
  const acceptance = classifyQueueAcceptance(item, providerMessageId, history);
  return acceptance.kind === "accepted" ? acceptance.evidence : null;
}
