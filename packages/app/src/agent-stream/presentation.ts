import { isTurnBoundary } from "./turn-membership";
import type { ChatDisplay } from "@/hooks/use-settings";
import type { TimelineItemTransform } from "@/plugins/timeline/model";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
  type PreparedToolCallHistory,
  type ToolCallDetailLevel,
  type ToolCallDetailProjection,
} from "@/tool-calls/detail-level/projection";
import type { StreamItem, UserMessageItem } from "@/types/stream";
import {
  collapseMachineTurns,
  joinMachineTurns,
  type MachineTurnLookups,
  type MachineTurns,
} from "./machine-turns/model";
import { collapseTurns, type TurnCollapse } from "./turn-collapse/model";
import type { ReadingRowReplacements } from "./reading-anchor";

interface PresentationInput {
  tail: StreamItem[];
  head: StreamItem[];
  transform: TimelineItemTransform | undefined;
  display: ChatDisplay;
  autoExpandReasoning?: boolean;
  /** User messages whose collapsed turn the reader opened. */
  expandedTurnHostIds: ReadonlySet<string>;
  /** Rows of the machine lines the reader opened; none when omitted. */
  expandedMachineRowIds?: ReadonlySet<string>;
  /** No older history remains to load, so the first row is the thread's first. */
  isTimelineStartLoaded?: boolean;
  isTurnActive: boolean;
  activeTurnId?: string | null;
}

export interface StreamPresentation extends ToolCallDetailProjection {
  turns: Omit<TurnCollapse, "tail">;
  machineTurns: MachineTurnLookups;
  readingRowReplacements: ReadingRowReplacements;
}

function groupedRowHosts(
  rows: readonly StreamItem[],
  groups: ToolCallDetailProjection["groupsByHostId"],
): ReadonlyMap<string, string> {
  const hosts = new Map<string, string>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (!group) continue;
    for (const call of group.run.calls) {
      if (call.id !== row.id) hosts.set(call.id, row.id);
    }
  }
  return hosts;
}

const NO_COLLAPSED_TURNS: StreamPresentation["turns"] = collapseTurns({
  tail: [],
  isLatestTurnOpen: false,
  expandedHostIds: new Set(),
  getGroupedCalls: () => undefined,
});

const NO_EXPANDED_MACHINE_ROWS: ReadonlySet<string> = new Set();

/** Source messages reach plugins before display projection. */
export function createStreamPresentation() {
  const userMessageCache = new WeakMap<UserMessageItem, UserMessageItem>();
  const receivedMessageCache = new WeakMap<StreamItem, UserMessageItem>();

  function presentUserMessage(item: UserMessageItem): UserMessageItem {
    const cached = userMessageCache.get(item);
    if (cached) return cached;

    // Recognize the complete voice envelope, including older messages without the
    // instruction suffix. Leave quoted examples and unrelated XML untouched.
    const spokenInput =
      /^\s*<spoken-input>([\s\S]*?)<\/spoken-input>(?:\s*<instruction>This message was spoken by the user\.[\s\S]*?<\/instruction>)?\s*$/.exec(
        item.text,
      );
    const projected = spokenInput ? { ...item, text: spokenInput[1].trim() } : item;
    userMessageCache.set(item, projected);
    return projected;
  }

  let historySource: StreamItem[] | undefined;
  let historyTransform: TimelineItemTransform | undefined;
  let historyRows: StreamItem[] = [];
  let preparedTail: StreamItem[] | undefined;
  let preparedAutoExpandReasoning: boolean | undefined;
  let preparedLevel: ToolCallDetailLevel | undefined;
  let preparedHistory: PreparedToolCallHistory | null = null;
  let historyGroupHosts: ReadonlyMap<string, string> = new Map();
  let collapsedSource: StreamItem[] | undefined;
  let collapsedIsLatestTurnOpen = false;
  let collapsedExpandedHostIds: ReadonlySet<string> | undefined;
  let collapsed: TurnCollapse | undefined;
  let machineTail: MachineTurns | undefined;
  let machineTailKey: readonly unknown[] = [];
  let machineHead: MachineTurns | undefined;

  function presentRows(item: StreamItem): StreamItem[] {
    if (item.kind === "tool_call" && item.payload.source === "agent") {
      const message = item.payload.data.agentMessage;
      if (message?.event === "message") {
        // One row per source call, so an unchanged message keeps its identity across passes.
        let received = receivedMessageCache.get(item);
        if (!received) {
          received = {
            kind: "user_message",
            id: item.id,
            turnId: item.turnId,
            timelineCursor: item.timelineCursor,
            timestamp: item.timestamp,
            text: message.text,
            sender: message.sender,
          };
          receivedMessageCache.set(item, received);
        }
        return [received];
      }
    }
    return [item.kind === "user_message" ? presentUserMessage(item) : item];
  }

  function collapse(
    projection: ToolCallDetailProjection,
    input: PresentationInput,
  ): Omit<StreamPresentation, "readingRowReplacements" | "machineTurns"> {
    if (input.display !== "collapseTurns") {
      return { ...projection, turns: NO_COLLAPSED_TURNS };
    }
    // Live text updates reach the head only, so the folded history is reused until the
    // retained rows, the latest turn's liveness, or the reader's expanded turns change.
    const last = projection.tail.at(-1) ?? null;
    const first = projection.head[0] ?? null;
    const activeTurnIsAnother = Boolean(
      input.activeTurnId && last?.turnId && input.activeTurnId !== last.turnId,
    );
    // Without head rows, the latest retained turn is live only while the active run is that
    // turn. A run that has not opened yet carries no id and belongs to the next turn.
    const isLatestTurnOpen = first
      ? !isTurnBoundary(last, first) && !activeTurnIsAnother
      : input.isTurnActive && (last?.turnId === undefined || input.activeTurnId === last.turnId);
    if (
      !collapsed ||
      collapsedSource !== projection.tail ||
      collapsedIsLatestTurnOpen !== isLatestTurnOpen ||
      collapsedExpandedHostIds !== input.expandedTurnHostIds
    ) {
      collapsed = collapseTurns({
        tail: projection.tail,
        isLatestTurnOpen,
        expandedHostIds: input.expandedTurnHostIds,
        getGroupedCalls: (itemId) => projection.groupsByHostId.get(itemId)?.run.calls,
      });
      collapsedSource = projection.tail;
      collapsedIsLatestTurnOpen = isLatestTurnOpen;
      collapsedExpandedHostIds = input.expandedTurnHostIds;
    }
    const { tail, ...turns } = collapsed;
    if (turns.nestedItemIds.size === 0) return { ...projection, tail, turns };
    // Opening a turn reveals its raw calls; those rows must not become group hosts again.
    const withoutExpandedRows = (groups: StreamPresentation["groupsByHostId"]) => ({
      size: groups.size - [...turns.nestedItemIds].filter((id) => groups.has(id)).length,
      get: (id: string) => (turns.nestedItemIds.has(id) ? undefined : groups.get(id)),
      has: (id: string) => !turns.nestedItemIds.has(id) && groups.has(id),
    });
    return {
      ...projection,
      tail,
      turns,
      groupsByHostId: withoutExpandedRows(projection.groupsByHostId),
      historyGroupUpdatesByHostId: withoutExpandedRows(projection.historyGroupUpdatesByHostId),
    };
  }

  function collapseMachineRows(
    result: Omit<StreamPresentation, "readingRowReplacements" | "machineTurns">,
    input: PresentationInput,
  ): { tail: StreamItem[]; head: StreamItem[]; machineTurns: MachineTurnLookups } {
    const expandedIds = input.expandedMachineRowIds ?? NO_EXPANDED_MACHINE_ROWS;
    // The Full display shows every row as it is. A thread's first row is its brief, so it keeps
    // full weight once the start of the timeline is known to be loaded.
    const showAll = input.display === "full";
    const firstId = input.isTimelineStartLoaded
      ? (result.tail[0] ?? result.head[0])?.id
      : undefined;
    const options = {
      expandedIds,
      // A collapsed turn's summary line hangs under its host, so that host keeps its own line.
      startsOwnGroup: (id: string) => result.turns.turnsByHostId.has(id),
      isExcluded: (id: string) => showAll || id === firstId || result.groupsByHostId.has(id),
      isNested: (id: string) => result.turns.nestedItemIds.has(id),
    };
    // Like turn collapse, retained history is folded again only when its inputs change. Only
    // the trailing retained row can become a tool-call group host between those changes.
    const last = result.tail.at(-1);
    const key = [
      result.tail,
      result.turns.turnsByHostId,
      result.turns.nestedItemIds,
      expandedIds,
      showAll,
      firstId,
      last ? result.groupsByHostId.has(last.id) : false,
    ];
    if (!machineTail || key.some((value, index) => value !== machineTailKey[index])) {
      machineTail = collapseMachineTurns({
        ...options,
        tail: result.tail,
        head: [],
        previous: machineTail,
      });
      machineTailKey = key;
    }
    machineHead = collapseMachineTurns({
      ...options,
      tail: [],
      head: result.head,
      previous: machineHead,
    });
    return {
      tail: machineTail.tail,
      head: machineHead.head,
      machineTurns: joinMachineTurns(machineTail, machineHead),
    };
  }

  return (input: PresentationInput): StreamPresentation => {
    const level: ToolCallDetailLevel = input.display === "full" ? "detailed" : "overview";
    // Retained history is not reprojected or regrouped on each live text update.
    if (historySource !== input.tail || historyTransform !== input.transform) {
      historyRows = projectPluginTimelineItems(input.tail, input.transform).flatMap<StreamItem>(
        (item) => presentRows(item),
      );
      historySource = input.tail;
      historyTransform = input.transform;
    }
    const head: StreamItem[] = [];
    for (const item of projectPluginTimelineItems(input.head, input.transform, "streaming")) {
      const blocks = presentRows(item);
      head.push(...blocks);
    }
    if (
      preparedTail !== historyRows ||
      preparedLevel !== level ||
      preparedAutoExpandReasoning !== input.autoExpandReasoning
    ) {
      preparedHistory = prepareToolCallHistory(level, historyRows, input.autoExpandReasoning);
      historyGroupHosts = preparedHistory
        ? groupedRowHosts(preparedHistory.grouped.tail, preparedHistory.grouped.groupsByHostId)
        : new Map();
      preparedTail = historyRows;
      preparedLevel = level;
      preparedAutoExpandReasoning = input.autoExpandReasoning;
    }
    const projection = projectToolCallDetailLevel({
      level,
      tail: historyRows,
      head,
      preparedHistory,
      isTurnActive: input.isTurnActive,
    });
    const result = collapse(projection, input);
    // Only the trailing retained group can absorb head rows. Reuse the retained
    // index across streaming updates rather than walking the full history again.
    const last = projection.tail.at(-1);
    const liveGroupHosts = groupedRowHosts(
      last ? [last, ...projection.head] : projection.head,
      projection.groupsByHostId,
    );
    const retainedGroupHosts = historyGroupHosts;
    const { tail, head: machineHeadRows, machineTurns } = collapseMachineRows(result, input);
    return {
      ...result,
      tail,
      head: machineHeadRows,
      machineTurns,
      readingRowReplacements: {
        get(id) {
          const machineHost = machineTurns.hostIdByHiddenRowId.get(id);
          if (machineHost) return machineHost;
          if (result.turns.nestedItemIds.has(id)) return undefined;
          const groupHost = liveGroupHosts.get(id) ?? retainedGroupHosts.get(id) ?? id;
          return (
            result.turns.hostIdByHiddenRowId.get(id) ??
            result.turns.hostIdByHiddenRowId.get(groupHost) ??
            (groupHost === id ? undefined : groupHost)
          );
        },
      },
    };
  };
}
