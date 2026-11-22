import type { QueueItem } from "@getpaseo/protocol/message-queue";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

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
  const sameText = new Map<string, QueueAcceptanceEvidence>();
  const startedAt = Date.parse(uncertain.delivery.startedAt);
  for (const event of history) {
    if (event.type !== "timeline" || event.item.type !== "user_message") continue;
    const message = event.item;
    if (
      message.clientMessageId === item.id ||
      message.messageId === item.id ||
      (providerMessageId !== undefined && message.messageId === providerMessageId)
    ) {
      identified.set(...evidenceOf(uncertain, event));
      continue;
    }
    // Claude transcripts keep no client message ID, and the provider ID is recorded after the
    // turn starts, so a delivery cut off by a crash can carry only its text. A timestamped
    // message with identical text after the attempt started is that delivery when it is unique.
    const at = event.timestamp ? Date.parse(event.timestamp) : Number.NaN;
    if (message.text === item.text && Number.isFinite(at) && at >= startedAt)
      sameText.set(...evidenceOf(uncertain, event));
  }
  // Repeated observations of one native message are fine. Multiple distinct
  // provider messages with the same client ID require explicit review.
  if (identified.size === 1) return { kind: "accepted", evidence: [...identified.values()][0] };
  if (identified.size > 1) return { kind: "ambiguous" };
  if (sameText.size === 1) return { kind: "accepted", evidence: [...sameText.values()][0] };
  return sameText.size > 1 ? { kind: "ambiguous" } : { kind: "none" };
}

export function findQueueAcceptanceEvidence(
  item: QueueItem,
  providerMessageId: string | undefined,
  history: readonly AgentStreamEvent[],
): QueueAcceptanceEvidence | null {
  const acceptance = classifyQueueAcceptance(item, providerMessageId, history);
  return acceptance.kind === "accepted" ? acceptance.evidence : null;
}
