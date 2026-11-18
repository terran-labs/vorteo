import { z } from "zod";
import {
  AgentTimelineItemPayloadSchema,
  ProfileSwitchTimelineItemSchema,
} from "@getpaseo/protocol/messages";
import type { AgentStreamEvent, AgentProvider } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";

export const ProfileSwitchRecordSchema = z.object({
  switchedAt: z.string(),
  marker: ProfileSwitchTimelineItemSchema,
});
export type ProfileSwitchRecord = z.infer<typeof ProfileSwitchRecordSchema>;

export const SwitchHistoryEventSchema = z.object({
  timestamp: z.string(),
  turnId: z.string().optional(),
  item: AgentTimelineItemPayloadSchema,
});
export type SwitchHistoryEvent = z.infer<typeof SwitchHistoryEventSchema>;

/**
 * Provider history covers only the current native session, which lives in the current
 * account's home. Everything the thread showed before its latest switch, ending with that
 * switch's marker, is retained and replayed first. Each switch retains only the rows after
 * the previous switch's marker; earlier rows already live in that switch's segment.
 */
export function* selectSwitchSegmentEvents(
  rows: readonly AgentTimelineRow[],
  previousSwitchId: string | null,
  record: ProfileSwitchRecord,
): Generator<SwitchHistoryEvent> {
  let start = 0;
  if (previousSwitchId !== null) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const item = rows[index].item;
      if (item.type === "profile_switch" && item.switchId === previousSwitchId) {
        start = index + 1;
        break;
      }
    }
  }
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index];
    yield {
      timestamp: row.timestamp,
      ...(row.turnId ? { turnId: row.turnId } : {}),
      item: row.item,
    };
  }
  yield { timestamp: record.switchedAt, item: record.marker };
}

export async function* prependSwitchHistory(
  retained: AsyncIterable<SwitchHistoryEvent> | Iterable<SwitchHistoryEvent> | null,
  provider: AgentProvider,
  history: AsyncIterable<AgentStreamEvent> | Iterable<AgentStreamEvent>,
): AsyncGenerator<AgentStreamEvent> {
  for await (const event of retained ?? []) {
    yield {
      type: "timeline",
      provider,
      timestamp: event.timestamp,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      item: event.item,
    };
  }
  yield* history;
}
