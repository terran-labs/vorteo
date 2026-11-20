import { buildAgentMessageDisplay } from "@getpaseo/protocol/paseo-tool-presentation/index";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";

/** What the collapsed line says about one machine row. */
export interface MachineRow {
  id: string;
  /** The sending agent's title, or its id when it has none. System rows have no sender. */
  sender?: string;
  /** The label the row's own component already shows, such as "Agent finished". */
  kind: string;
  timestamp: Date;
  preview: string;
}

export interface MachineGroup {
  /** The first row of the run; it carries the collapsed line. */
  hostId: string;
  expanded: boolean;
  rows: readonly MachineRow[];
}

export interface MachineTurns {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ReadonlyMap<string, MachineGroup>;
  /** The group a message sits in, for surfaces that must reveal it. Includes the host. */
  hostIdByFoldedMessageId: ReadonlyMap<string, string>;
  /** Rows a closed group replaced with its host, for preserving the reading position. */
  hostIdByHiddenRowId: ReadonlyMap<string, string>;
}

export interface CollapseMachineTurnsInput {
  tail: StreamItem[];
  head: StreamItem[];
  expandedHostIds: ReadonlySet<string>;
  /** Rows that must keep their own line, such as the host of a collapsed turn. */
  startsOwnGroup: (itemId: string) => boolean;
  /** Rows another display owns, such as the host of a tool-call group. */
  isExcluded: (itemId: string) => boolean;
  /** Rows inside an opened turn never share a line with rows outside it. */
  isNested: (itemId: string) => boolean;
  /** The previous result, so unchanged group hosts keep their row identity. */
  previous?: MachineTurns;
}

const PREVIEW_WORDS = 12;
const SYSTEM_CALL_ID_PREFIX = "paseo-system:";

function preview(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, PREVIEW_WORDS).join(" ");
}

/**
 * Describes a row only when its structure proves a machine produced it. Message text is never
 * inspected: a user message without a sender is the owner's, whatever it contains.
 */
export function describeMachineRow(item: StreamItem): MachineRow | null {
  if (item.kind === "user_message") {
    // Presentation derives these from `agent_message` tool calls; submitted prompts have no sender.
    if (!item.sender) return null;
    const display = buildAgentMessageDisplay({
      event: "message",
      sender: item.sender,
      text: item.text,
    });
    return {
      id: item.id,
      sender: item.sender.title ?? item.sender.id,
      kind: display.displayName,
      timestamp: item.timestamp,
      preview: preview(item.text),
    };
  }
  if (item.kind !== "tool_call" || item.payload.source !== "agent") return null;
  const { data } = item.payload;
  if (data.agentMessage) {
    return {
      id: item.id,
      sender: data.agentMessage.sender.title ?? data.agentMessage.sender.id,
      kind: buildAgentMessageDisplay(data.agentMessage).displayName,
      timestamp: item.timestamp,
      preview: preview(data.agentMessage.text),
    };
  }
  const isSystemRow = data.name === "heartbeat" && data.callId.startsWith(SYSTEM_CALL_ID_PREFIX);
  if (!isSystemRow && data.name !== "task_notification") return null;
  const display = buildToolCallDisplayModel({
    name: data.name,
    status: data.status,
    error: data.error,
    detail: data.detail,
    metadata: data.metadata,
  });
  return {
    id: item.id,
    kind: display.displayName,
    timestamp: item.timestamp,
    preview: preview(
      (data.detail.type === "plain_text" ? data.detail.text : display.summary) ?? "",
    ),
  };
}

interface Accumulator {
  groupsByHostId: Map<string, MachineGroup>;
  hostIdByFoldedMessageId: Map<string, string>;
  hostIdByHiddenRowId: Map<string, string>;
  /** The row emitted for each host, and the source it stands for. */
  hostRows: Map<string, { source: StreamItem; row: StreamItem; group: MachineGroup }>;
}

const previousHostRows = new WeakMap<MachineTurns, Accumulator["hostRows"]>();

function sameGroup(left: MachineGroup, right: MachineGroup): boolean {
  return (
    left.expanded === right.expanded &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, index) => row.id === right.rows[index]!.id)
  );
}

function collapseRows(
  rows: StreamItem[],
  input: CollapseMachineTurnsInput,
  accumulator: Accumulator,
): StreamItem[] {
  const output: StreamItem[] = [];
  let changed = false;
  let run: { item: StreamItem; row: MachineRow }[] = [];

  const flush = () => {
    const host = run[0];
    if (!host) return;
    const hostId = host.item.id;
    const expanded = input.expandedHostIds.has(hostId);
    const group: MachineGroup = { hostId, expanded, rows: run.map((member) => member.row) };
    accumulator.groupsByHostId.set(hostId, group);
    for (const member of run) {
      accumulator.hostIdByFoldedMessageId.set(getStreamItemMessageId(member.item), hostId);
      if (!expanded && member !== host) accumulator.hostIdByHiddenRowId.set(member.item.id, hostId);
    }
    // Row identity is the render signal for history rows, so a host whose line changed gets a
    // fresh identity and an unchanged host keeps the one it had.
    const before = input.previous && previousHostRows.get(input.previous)?.get(hostId);
    let row = host.item;
    if (before && before.source === host.item) {
      row = sameGroup(before.group, group) ? before.row : { ...host.item };
    }
    accumulator.hostRows.set(hostId, { source: host.item, row, group });
    if (row !== host.item || (!expanded && run.length > 1)) changed = true;
    output.push(row);
    if (expanded) output.push(...run.slice(1).map((member) => member.item));
    run = [];
  };

  for (const item of rows) {
    const row = input.isExcluded(item.id) ? null : describeMachineRow(item);
    if (!row) {
      flush();
      output.push(item);
      continue;
    }
    const last = run.at(-1);
    if (
      last &&
      (input.startsOwnGroup(item.id) || input.isNested(last.item.id) !== input.isNested(item.id))
    ) {
      flush();
    }
    run.push({ item, row });
  }
  flush();
  return changed ? output : rows;
}

/**
 * Folds each run of adjacent machine rows into its first row, which renders one muted line.
 * Opening the line restores every row of the run, rendered by its own component. Runs after
 * turn collapse, on the rows that are still visible, and never changes the source timeline.
 */
export function collapseMachineTurns(input: CollapseMachineTurnsInput): MachineTurns {
  const accumulator: Accumulator = {
    groupsByHostId: new Map(),
    hostIdByFoldedMessageId: new Map(),
    hostIdByHiddenRowId: new Map(),
    hostRows: new Map(),
  };
  const tail = collapseRows(input.tail, input, accumulator);
  const head = collapseRows(input.head, input, accumulator);
  const result: MachineTurns = {
    tail,
    head,
    groupsByHostId: accumulator.groupsByHostId,
    hostIdByFoldedMessageId: accumulator.hostIdByFoldedMessageId,
    hostIdByHiddenRowId: accumulator.hostIdByHiddenRowId,
  };
  previousHostRows.set(result, accumulator.hostRows);
  return result;
}
