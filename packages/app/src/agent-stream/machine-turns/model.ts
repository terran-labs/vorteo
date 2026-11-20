import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { buildAgentMessageDisplay } from "@getpaseo/protocol/paseo-tool-presentation/index";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";

/** What the collapsed line says about one machine row. */
export interface MachineRow {
  id: string;
  /** The sending agent. System rows and task notifications have none. */
  sender?: AgentMessage["sender"];
  /**
   * The name the row's own tool-call component shows, such as "Agent finished". Absent for a
   * received agent message, whose own component shows only who sent it.
   */
  label?: string;
  timestamp: Date;
  preview: string;
}

export interface MachineGroup {
  /** The first row of the run; it carries the collapsed line. */
  hostId: string;
  expanded: boolean;
  rows: readonly MachineRow[];
}

interface Lookup<Value> {
  get(id: string): Value | undefined;
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

/** The lookups a view needs, whichever pass produced them. */
export interface MachineTurnLookups {
  groupsByHostId: Lookup<MachineGroup>;
  hostIdByFoldedMessageId: Lookup<string>;
  hostIdByHiddenRowId: Lookup<string>;
}

export interface CollapseMachineTurnsInput {
  tail: StreamItem[];
  head: StreamItem[];
  /** A group is open while any of its rows is listed, so it stays open when its host changes. */
  expandedIds: ReadonlySet<string>;
  /** Rows that must keep their own line, such as the host of a collapsed turn. */
  startsOwnGroup: (itemId: string) => boolean;
  /** Rows that keep full weight: another display owns them, or the owner must see them. */
  isExcluded: (itemId: string) => boolean;
  /** Rows inside an opened turn never share a line with rows outside it. */
  isNested: (itemId: string) => boolean;
  /** The previous result, so unchanged groups and rows keep their identity. */
  previous?: MachineTurns;
}

const PREVIEW_WORDS = 12;
const SYSTEM_CALL_ID_PREFIX = "paseo-system:";
const TASK_NOTIFICATION_SOURCE = "claude_task_notification";

function preview(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, PREVIEW_WORDS).join(" ");
}

/**
 * Describes a row only when its structure proves a machine produced it and nothing in it asks
 * for the owner's attention. Message text is never inspected: a user message without a sender
 * is the owner's, whatever it contains. Errors, permission requests and failed or running calls
 * return null, so they keep full weight.
 */
export function describeMachineRow(item: StreamItem): MachineRow | null {
  if (item.kind === "user_message") {
    // Presentation derives these from `agent_message` tool calls; submitted prompts have no sender.
    if (!item.sender) return null;
    return {
      id: item.id,
      sender: item.sender,
      timestamp: item.timestamp,
      preview: preview(item.text),
    };
  }
  if (item.kind !== "tool_call" || item.payload.source !== "agent") return null;
  const { data } = item.payload;
  if (data.status === "failed" || data.status === "running") return null;
  const message = data.agentMessage;
  if (message) {
    if (message.event === "errored" || message.event === "permission-required") return null;
    return {
      id: item.id,
      sender: message.sender,
      ...(message.event === "message"
        ? {}
        : { label: buildAgentMessageDisplay(message).displayName }),
      timestamp: item.timestamp,
      preview: preview(message.text),
    };
  }
  const isSystemRow = data.name === "heartbeat" && data.callId.startsWith(SYSTEM_CALL_ID_PREFIX);
  // A provider tool can be named anything, so the name alone is not proof; the daemon stamps
  // the notifications it synthesizes.
  const isTaskNotification =
    data.name === "task_notification" &&
    data.metadata?.synthetic === true &&
    data.metadata.source === TASK_NOTIFICATION_SOURCE;
  if (!isSystemRow && !isTaskNotification) return null;
  const display = buildToolCallDisplayModel({
    name: data.name,
    status: data.status,
    error: data.error,
    detail: data.detail,
    metadata: data.metadata,
  });
  return {
    id: item.id,
    label: display.displayName,
    timestamp: item.timestamp,
    preview: preview(
      (data.detail.type === "plain_text" ? data.detail.text : display.summary) ?? "",
    ),
  };
}

/** What one pass emitted for a row, so the next pass can keep or revise its identity. */
interface Emitted {
  source: StreamItem;
  row: StreamItem;
  /** The run the row hosted, or null when it rendered at full weight after hosting one. */
  hosted: { group: MachineGroup; sources: readonly StreamItem[] } | null;
}

interface PassMemory {
  emitted: Map<string, Emitted>;
  /** Rows passed through untouched, which need a new identity if they later host a line. */
  plain: WeakSet<StreamItem>;
}

interface Accumulator extends PassMemory {
  groupsByHostId: Map<string, MachineGroup>;
  hostIdByFoldedMessageId: Map<string, string>;
  hostIdByHiddenRowId: Map<string, string>;
}

const passMemory = new WeakMap<MachineTurns, PassMemory>();

function collapseRows(
  rows: StreamItem[],
  input: CollapseMachineTurnsInput,
  accumulator: Accumulator,
): StreamItem[] {
  const before = input.previous && passMemory.get(input.previous);
  const output: StreamItem[] = [];
  let changed = false;
  let run: { item: StreamItem; row: MachineRow }[] = [];

  const flush = () => {
    const host = run[0];
    if (!host) return;
    const hostId = host.item.id;
    const sources = run.map((member) => member.item);
    const expanded = sources.some((source) => input.expandedIds.has(source.id));
    // Row identity is the render signal for history rows. An unchanged run keeps its group and
    // its host row, so its line does not render again; a changed one gets a fresh host row.
    const previous = before?.emitted.get(hostId);
    const sameSource = previous?.source === host.item;
    const hosted = sameSource ? previous.hosted : null;
    const unchanged =
      hosted !== null &&
      hosted.group.expanded === expanded &&
      hosted.sources.length === sources.length &&
      hosted.sources.every((source, index) => source === sources[index]);
    const group: MachineGroup = unchanged
      ? hosted.group
      : { hostId, expanded, rows: run.map((member) => member.row) };
    let row = host.item;
    if (unchanged) row = previous!.row;
    else if (sameSource || before?.plain.has(host.item)) row = { ...host.item };
    accumulator.emitted.set(hostId, { source: host.item, row, hosted: { group, sources } });
    accumulator.groupsByHostId.set(hostId, group);
    for (const member of run) {
      accumulator.hostIdByFoldedMessageId.set(getStreamItemMessageId(member.item), hostId);
      if (!expanded && member !== host) accumulator.hostIdByHiddenRowId.set(member.item.id, hostId);
    }
    if (row !== host.item || (!expanded && run.length > 1)) changed = true;
    output.push(row);
    if (expanded) output.push(...sources.slice(1));
    run = [];
  };

  const pushPlain = (item: StreamItem) => {
    // A row that hosted a line and now renders at full weight must redraw too.
    const previous = before?.emitted.get(item.id);
    if (previous?.source !== item) {
      accumulator.plain.add(item);
      output.push(item);
      return;
    }
    const row = previous.hosted ? { ...item } : previous.row;
    accumulator.emitted.set(item.id, { source: item, row, hosted: null });
    changed = true;
    output.push(row);
  };

  for (const item of rows) {
    const row = input.isExcluded(item.id) ? null : describeMachineRow(item);
    if (!row) {
      flush();
      pushPlain(item);
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
    emitted: new Map(),
    plain: new WeakSet(),
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
  passMemory.set(result, { emitted: accumulator.emitted, plain: accumulator.plain });
  return result;
}

/** Reads the live head's lookups before retained history's, without copying either. */
export function joinMachineTurns(tail: MachineTurns, head: MachineTurns): MachineTurnLookups {
  if (head.groupsByHostId.size === 0) return tail;
  const join = <Value>(first: Lookup<Value>, second: Lookup<Value>): Lookup<Value> => ({
    get: (id) => first.get(id) ?? second.get(id),
  });
  return {
    groupsByHostId: join(head.groupsByHostId, tail.groupsByHostId),
    hostIdByFoldedMessageId: join(head.hostIdByFoldedMessageId, tail.hostIdByFoldedMessageId),
    hostIdByHiddenRowId: join(head.hostIdByHiddenRowId, tail.hostIdByHiddenRowId),
  };
}
