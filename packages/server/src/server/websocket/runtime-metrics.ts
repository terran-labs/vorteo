import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { SessionOutboundMessage, WSOutboundMessage } from "../messages.js";
import type { ProcessMemoryDiagnostics } from "../process-diagnostics.js";

export interface WebSocketRuntimeCounters {
  connectedAwaitingHello: number;
  helloResumed: number;
  helloNew: number;
  pendingDisconnected: number;
  sessionDisconnectedWaitingReconnect: number;
  sessionSocketDisconnectedAttached: number;
  sessionCleanup: number;
  validationFailed: number;
  binaryBeforeHelloRejected: number;
  pendingMessageRejectedBeforeHello: number;
  missingConnectionForMessage: number;
  unexpectedHelloOnActiveConnection: number;
  relayExternalSocketAttached: number;
  originRejected: number;
  hostRejected: number;
  applicationJsonRejected: number;
  applicationBinaryRejected: number;
}

export interface WebSocketRuntimeMetricsSnapshot {
  traffic: ReturnType<WebSocketTrafficMetrics["snapshotAndReset"]>;
  windowMs: number;
  counters: WebSocketRuntimeCounters;
  inboundMessageTypesTop: Array<[string, number]>;
  inboundSessionRequestTypesTop: Array<[string, number]>;
  outboundMessageTypesTop: Array<[string, number]>;
  outboundSessionMessageTypesTop: Array<[string, number]>;
  outboundAgentStreamTypesTop: Array<[string, number]>;
  outboundAgentStreamAgentsTop: Array<[string, number]>;
  outboundBinaryFrameTypesTop: Array<[string, number]>;
  bufferedAmount: {
    p95: number;
    max: number;
  };
  latency: Array<{
    type: string;
    count: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    totalMs: number;
  }>;
}

export interface WebSocketRuntimeDiagnosticSnapshot<
  TRuntime = unknown,
  TAgents = unknown,
  TGit = unknown,
> extends WebSocketRuntimeMetricsSnapshot {
  collectedAt: string;
  final: boolean;
  sessions: {
    activeConnections: number;
    externalSessionKeys: number;
    reconnectGraceSessions: number;
  };
  sockets: {
    activeSockets: number;
    pendingConnections: number;
  };
  eventLoopDelay: {
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
  } | null;
  uptimeSeconds: number;
  memory: ProcessMemoryDiagnostics;
  runtime: TRuntime;
  agents: TAgents;
  git: TGit;
}

type Clock = () => number;

export class WebSocketRuntimeMetricsWindow {
  readonly traffic: WebSocketTrafficMetrics;
  private windowStartedAt: number;
  private readonly counters: WebSocketRuntimeCounters = createRuntimeCounters();
  private readonly inboundMessageCounts = new Map<string, number>();
  private readonly inboundSessionRequestCounts = new Map<string, number>();
  private readonly outboundMessageCounts = new Map<string, number>();
  private readonly outboundSessionMessageCounts = new Map<string, number>();
  private readonly outboundAgentStreamCounts = new Map<string, number>();
  private readonly outboundAgentStreamByAgentCounts = new Map<string, number>();
  private readonly outboundBinaryFrameCounts = new Map<string, number>();
  private readonly bufferedAmountSamples: number[] = [];
  private readonly requestLatencies = new Map<string, number[]>();

  constructor(private readonly clock: Clock = Date.now) {
    this.windowStartedAt = this.clock();
    this.traffic = new WebSocketTrafficMetrics(clock);
  }

  incrementCounter(counter: keyof WebSocketRuntimeCounters): void {
    this.counters[counter] += 1;
  }

  recordInboundMessage(type: string): void {
    incrementCount(this.inboundMessageCounts, type);
  }

  recordInboundSessionRequest(type: string): void {
    incrementCount(this.inboundSessionRequestCounts, type);
  }

  recordOutboundMessage(message: WSOutboundMessage, bufferedAmount?: number): void {
    if (message.type !== "session") {
      incrementCount(this.outboundMessageCounts, message.type);
      this.recordBufferedAmount(bufferedAmount);
      return;
    }

    incrementCount(this.outboundMessageCounts, "session_message");
    incrementCount(this.outboundSessionMessageCounts, message.message.type);

    if (message.message.type === "agent_stream") {
      this.recordOutboundAgentStreamMessage(message.message.payload);
    }

    this.recordBufferedAmount(bufferedAmount);
  }

  recordOutboundBinaryFrame(bufferedAmount?: number): void {
    incrementCount(this.outboundBinaryFrameCounts, "binary");
    this.recordBufferedAmount(bufferedAmount);
  }

  recordRequestLatency(type: string, durationMs: number): void {
    let latencies = this.requestLatencies.get(type);
    if (!latencies) {
      latencies = [];
      this.requestLatencies.set(type, latencies);
    }
    latencies.push(durationMs);
  }

  snapshotAndReset(): WebSocketRuntimeMetricsSnapshot {
    const now = this.clock();
    const snapshot: WebSocketRuntimeMetricsSnapshot = {
      traffic: this.traffic.snapshotAndReset(),
      windowMs: Math.max(0, now - this.windowStartedAt),
      counters: { ...this.counters },
      inboundMessageTypesTop: getTopCounts(this.inboundMessageCounts, 12),
      inboundSessionRequestTypesTop: getTopCounts(this.inboundSessionRequestCounts, 20),
      outboundMessageTypesTop: getTopCounts(this.outboundMessageCounts, 12),
      outboundSessionMessageTypesTop: getTopCounts(this.outboundSessionMessageCounts, 20),
      outboundAgentStreamTypesTop: getTopCounts(this.outboundAgentStreamCounts, 20),
      outboundAgentStreamAgentsTop: getTopCounts(this.outboundAgentStreamByAgentCounts, 20),
      outboundBinaryFrameTypesTop: getTopCounts(this.outboundBinaryFrameCounts, 12),
      bufferedAmount: this.computeBufferedAmountStats(),
      latency: this.computeLatencyStats(),
    };

    this.reset(now);
    return snapshot;
  }

  private recordOutboundAgentStreamMessage(
    payload: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"],
  ): void {
    const { agentId, event } = payload;
    const eventType = event.type === "timeline" ? `timeline:${event.item.type}` : event.type;
    incrementCount(this.outboundAgentStreamCounts, eventType);
    incrementCount(this.outboundAgentStreamByAgentCounts, agentId);
  }

  private recordBufferedAmount(bufferedAmount: number | undefined): void {
    if (typeof bufferedAmount !== "number") {
      return;
    }
    this.bufferedAmountSamples.push(bufferedAmount);
  }

  private computeLatencyStats(): WebSocketRuntimeMetricsSnapshot["latency"] {
    const stats: WebSocketRuntimeMetricsSnapshot["latency"] = [];
    for (const [type, latencies] of this.requestLatencies) {
      if (latencies.length === 0) continue;
      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const count = sortedLatencies.length;
      const minMs = Math.round(sortedLatencies[0]);
      const maxMs = Math.round(sortedLatencies[count - 1]);
      const p50Ms = Math.round(sortedLatencies[Math.floor(count / 2)]);
      const totalMs = Math.round(sortedLatencies.reduce((sum, value) => sum + value, 0));
      stats.push({ type, count, minMs, maxMs, p50Ms, totalMs });
    }
    stats.sort((a, b) => b.totalMs - a.totalMs);
    return stats.slice(0, 15);
  }

  private computeBufferedAmountStats(): WebSocketRuntimeMetricsSnapshot["bufferedAmount"] {
    if (this.bufferedAmountSamples.length === 0) {
      return { p95: 0, max: 0 };
    }

    const samples = [...this.bufferedAmountSamples].sort((a, b) => a - b);
    const p95Index = Math.ceil(samples.length * 0.95) - 1;
    return {
      p95: samples[p95Index] ?? 0,
      max: samples[samples.length - 1] ?? 0,
    };
  }

  private reset(windowStartedAt: number): void {
    for (const counter of Object.keys(this.counters) as Array<keyof WebSocketRuntimeCounters>) {
      this.counters[counter] = 0;
    }
    this.inboundMessageCounts.clear();
    this.inboundSessionRequestCounts.clear();
    this.outboundMessageCounts.clear();
    this.outboundSessionMessageCounts.clear();
    this.outboundAgentStreamCounts.clear();
    this.outboundAgentStreamByAgentCounts.clear();
    this.outboundBinaryFrameCounts.clear();
    this.bufferedAmountSamples.length = 0;
    this.requestLatencies.clear();
    this.windowStartedAt = windowStartedAt;
  }
}

function createRuntimeCounters(): WebSocketRuntimeCounters {
  return {
    connectedAwaitingHello: 0,
    helloResumed: 0,
    helloNew: 0,
    pendingDisconnected: 0,
    sessionDisconnectedWaitingReconnect: 0,
    sessionSocketDisconnectedAttached: 0,
    sessionCleanup: 0,
    validationFailed: 0,
    binaryBeforeHelloRejected: 0,
    pendingMessageRejectedBeforeHello: 0,
    missingConnectionForMessage: 0,
    unexpectedHelloOnActiveConnection: 0,
    relayExternalSocketAttached: 0,
    originRejected: 0,
    hostRejected: 0,
    applicationJsonRejected: 0,
    applicationBinaryRejected: 0,
  };
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function getTopCounts(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const TRAFFIC_CONNECTION_CAP = 256;
const TRAFFIC_CLIENT_CAP = 128;
const TRAFFIC_TYPE_CAP = 128;
const TRAFFIC_RETENTION_MS = 10 * 60_000;
const BURST_WINDOWS_MS = [1_000, 5_000, 10_000];

export type TrafficOutcome = "fulfilled" | "rejectedOrFailed" | "synchronousRejection";
export type PhysicalTrafficOutcome =
  | "attempted"
  | "rejected"
  | "accepted"
  | "completed"
  | "failed"
  | "completionUnknown";

type TrafficTransport = "direct" | "relay" | "hub" | "externalAdapter" | "routed" | "unknown";

interface TrafficConnectionIdentity {
  connectionId: string;
  transport: "direct" | "relay" | "hub" | "externalAdapter";
  peer: "loopback" | "local_ipc" | "external";
  browserOrigin: boolean;
}

interface TrafficVolume {
  count: number;
  bytes: number;
}

interface TrafficTotals {
  logicalAttempts: TrafficVolume;
  fulfilled: TrafficVolume;
  rejectedOrFailed: TrafficVolume;
  synchronousRejection: TrafficVolume;
  physicalFrames: Record<PhysicalTrafficOutcome, TrafficVolume>;
  routedFrames: Record<PhysicalTrafficOutcome, TrafficVolume>;
  publications: number;
  recipientCandidates: number;
  rejectedBeforeSerialization: number;
}

interface TrafficConnection extends TrafficConnectionIdentity {
  clientType: string;
  routed: boolean;
  client: string | null;
  hello: "pending" | "initial" | "resumed";
  reconnectOrdinal: number | null;
  openedAt: number;
  closedAt: number | null;
  attempted: TrafficVolume;
  frameAttempts: TrafficVolume;
  frameAccepted: TrafficVolume;
  types: Map<string, number>;
  bursts: Array<{
    windowMs: number;
    bytes: number;
    windowBytes: number;
    types: Map<string, number>;
  }>;
}

interface TrafficContinuity {
  lastSeenAt: number;
  connections: number;
}

interface TrafficDay {
  date: string;
  coveredStart: number;
  coveredEnd: number;
  totals: TrafficTotals;
  types: Map<string, number>;
  transports: Map<TrafficTransport, number>;
  acceptedFrameTransports: Map<TrafficTransport, number>;
}

/** Counts observation layers independently. None of these counters prove client receipt. */
export class WebSocketTrafficMetrics {
  private readonly epoch = randomUUID();
  private readonly key = randomBytes(32);
  private readonly startedAt: number;
  private windowStartedAt: number;
  private totals = trafficTotals();
  private readonly types = new Map<string, number>();
  private readonly typeKeys = new Set<string>();
  private readonly transports = new Map<TrafficTransport, number>();
  private readonly frameTransports = new Map<TrafficTransport, number>();
  private readonly connections = new Map<string, TrafficConnection>();
  private readonly clients = new Map<string, TrafficContinuity>();
  private readonly days = new Map<string, TrafficDay>();
  private dayNumber = Number.NaN;
  private day: TrafficDay | undefined;
  private connectionOverflow = 0;
  private clientEvictions = 0;
  private unattributed = volume();

  constructor(private readonly clock: Clock = Date.now) {
    this.startedAt = clock();
    this.windowStartedAt = this.startedAt;
    this.currentDay(this.startedAt);
  }

  open(identity: TrafficConnectionIdentity): void {
    if (this.connections.has(identity.connectionId)) return;
    if (this.connections.size >= TRAFFIC_CONNECTION_CAP) {
      this.connectionOverflow++;
      return;
    }
    // Copy only allowlisted fields. The source identity also contains private request metadata.
    this.connections.set(identity.connectionId, {
      connectionId: identity.connectionId,
      transport: identity.transport,
      peer: identity.peer,
      browserOrigin: identity.browserOrigin,
      clientType: "unknown",
      routed: false,
      client: null,
      hello: "pending",
      reconnectOrdinal: null,
      openedAt: this.clock(),
      closedAt: null,
      attempted: volume(),
      frameAttempts: volume(),
      frameAccepted: volume(),
      types: new Map(),
      bursts: BURST_WINDOWS_MS.map((windowMs) => ({
        windowMs,
        bytes: 0,
        windowBytes: 0,
        types: new Map(),
      })),
    });
  }

  hello(params: {
    connectionId: string;
    continuityKey: string;
    clientType: "mobile" | "browser" | "cli" | "mcp" | "hub";
    resumed: boolean;
    routed: boolean;
  }): void {
    const connection = this.connections.get(params.connectionId);
    if (!connection) return;
    const now = this.clock();
    this.expireClients(now);
    const client = createHmac("sha256", this.key)
      .update(params.continuityKey)
      .digest("hex")
      .slice(0, 24);
    const previous = this.clients.get(client);
    connection.reconnectOrdinal = previous ? previous.connections : null;
    if (!previous && this.clients.size >= TRAFFIC_CLIENT_CAP) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
      this.clientEvictions++;
    }
    this.clients.delete(client);
    this.clients.set(client, { lastSeenAt: now, connections: (previous?.connections ?? 0) + 1 });
    connection.client = client;
    connection.clientType = params.clientType;
    connection.routed = params.routed;
    connection.hello = params.resumed ? "resumed" : "initial";
  }

  close(connectionId: string | undefined): void {
    if (!connectionId) return;
    const connection = this.connections.get(connectionId);
    if (connection && connection.closedAt === null) connection.closedAt = this.clock();
  }

  publication(recipients: number): void {
    this.eachTotals((totals) => {
      totals.publications++;
      totals.recipientCandidates += recipients;
    });
  }

  rejectBeforeSerialization(): void {
    this.eachTotals((totals) => totals.rejectedBeforeSerialization++);
  }

  attempt(params: { connectionId: string | undefined; type: string; bytes: number }): void {
    const now = this.clock();
    const type = this.typeKey(params.type);
    this.eachTotals((totals) => addVolume(totals.logicalAttempts, params.bytes));
    addBytes(this.types, type, params.bytes);
    const day = this.currentDay(now);
    addBytes(day.types, type, params.bytes);
    const connection = params.connectionId ? this.connections.get(params.connectionId) : undefined;
    if (!connection) {
      addVolume(this.unattributed, params.bytes);
      addBytes(this.transports, "unknown", params.bytes);
      addBytes(day.transports, "unknown", params.bytes);
      return;
    }
    const transport = connection.routed ? "routed" : connection.transport;
    addBytes(this.transports, transport, params.bytes);
    addBytes(day.transports, transport, params.bytes);
    addVolume(connection.attempted, params.bytes);
    addBytes(connection.types, type, params.bytes);
    const age = Math.max(0, now - connection.openedAt);
    for (const burst of connection.bursts) {
      if (age >= burst.windowMs) continue;
      burst.bytes += params.bytes;
      burst.windowBytes += params.bytes;
      addBytes(burst.types, type, params.bytes);
    }
    const client = connection.client ? this.clients.get(connection.client) : undefined;
    if (client && connection.client) {
      client.lastSeenAt = now;
      this.clients.delete(connection.client);
      this.clients.set(connection.client, client);
    }
  }

  outcome(outcome: TrafficOutcome, bytes: number): void {
    this.eachTotals((totals) => addVolume(totals[outcome], bytes));
  }

  physical(params: {
    connectionId?: string;
    routed: boolean;
    outcome: PhysicalTrafficOutcome;
    bytes: number;
  }): void {
    const connection = params.connectionId ? this.connections.get(params.connectionId) : undefined;
    if (params.outcome === "attempted" && connection)
      addVolume(connection.frameAttempts, params.bytes);
    if (params.outcome === "accepted") {
      if (connection) addVolume(connection.frameAccepted, params.bytes);
      const transport = params.routed ? "routed" : (connection?.transport ?? "unknown");
      addBytes(this.frameTransports, transport, params.bytes);
      addBytes(this.currentDay(this.clock()).acceptedFrameTransports, transport, params.bytes);
    }
    this.eachTotals((totals) => {
      const layer = params.routed ? totals.routedFrames : totals.physicalFrames;
      addVolume(layer[params.outcome], params.bytes);
    });
  }

  snapshotAndReset() {
    const now = this.clock();
    this.expireClients(now);
    this.currentDay(now);
    const connections = [...this.connections.values()].sort(
      (a, b) => b.attempted.bytes - a.attempted.bytes,
    );
    const top = connections.slice(0, 12).map((connection) => ({
      connectionId: connection.connectionId,
      transport: connection.transport,
      routed: connection.routed,
      peer: connection.peer,
      browserOrigin: connection.browserOrigin,
      clientType: connection.clientType,
      client: connection.client,
      hello: connection.hello,
      reconnectOrdinal: connection.reconnectOrdinal,
      ageMs: Math.max(0, (connection.closedAt ?? now) - connection.openedAt),
      closed: connection.closedAt !== null,
      attempted: { ...connection.attempted },
      frameAttempts: { ...connection.frameAttempts },
      frameAccepted: { ...connection.frameAccepted },
      types: topBytes(connection.types),
      bursts: connection.bursts.map((burst) => ({
        windowMs: burst.windowMs,
        cumulativeAttemptedBytes: burst.bytes,
        windowAttemptedBytes: burst.windowBytes,
        types: topBytes(burst.types),
      })),
    }));
    const burstConnections = connections
      .filter((connection) => connection.bursts[2].windowBytes > 0)
      .sort((a, b) => b.bursts[2].windowBytes - a.bursts[2].windowBytes);
    const snapshot = {
      processEpoch: this.epoch,
      processStartedAt: this.startedAt,
      coveredStart: this.windowStartedAt,
      coveredEnd: now,
      logicalAdmission: "unknown" as const,
      burstBasis: "attemptTime" as const,
      totals: this.totals,
      types: topBytes(this.types),
      transports: Object.fromEntries(this.transports),
      acceptedFrameTransports: Object.fromEntries(this.frameTransports),
      connections: top,
      otherBurstWindowAttemptedBytes: burstConnections
        .slice(12)
        .reduce((sum, c) => sum + c.bursts[2].windowBytes, 0),
      burstConnections: burstConnections.slice(0, 12).map((connection) => ({
        connectionId: connection.connectionId,
        windows: connection.bursts.map((burst) => ({
          windowMs: burst.windowMs,
          cumulativeAttemptedBytes: burst.bytes,
          windowAttemptedBytes: burst.windowBytes,
          types: topBytes(burst.types),
        })),
      })),
      otherConnectionAttemptedBytes: connections
        .slice(12)
        .reduce((sum, c) => sum + c.attempted.bytes, 0),
      unattributedAttempts: this.unattributed,
      connectionOverflow: this.connectionOverflow,
      clientEvictions: this.clientEvictions,
      retainedConnections: this.connections.size,
      retainedClients: this.clients.size,
      days: [...this.days.values()].map((day) => ({
        date: day.date,
        coveredStart: day.coveredStart,
        coveredEnd: day.coveredEnd,
        totals: structuredClone(day.totals),
        types: topBytes(day.types),
        transports: Object.fromEntries(day.transports),
        acceptedFrameTransports: Object.fromEntries(day.acceptedFrameTransports),
      })),
    };
    this.totals = trafficTotals();
    this.types.clear();
    this.transports.clear();
    this.frameTransports.clear();
    this.unattributed = volume();
    this.connectionOverflow = 0;
    this.clientEvictions = 0;
    this.windowStartedAt = now;
    for (const [id, connection] of this.connections) {
      if (connection.closedAt !== null) this.connections.delete(id);
      else {
        connection.attempted = volume();
        connection.frameAttempts = volume();
        connection.frameAccepted = volume();
        connection.types.clear();
        for (const burst of connection.bursts) burst.windowBytes = 0;
      }
    }
    return snapshot;
  }

  private typeKey(type: string): string {
    if (this.typeKeys.has(type)) return type;
    if (this.typeKeys.size >= TRAFFIC_TYPE_CAP - 1) return "other";
    this.typeKeys.add(type);
    return type;
  }

  private eachTotals(update: (totals: TrafficTotals) => void): void {
    update(this.totals);
    update(this.currentDay(this.clock()).totals);
  }

  private currentDay(now: number): TrafficDay {
    const dayNumber = Math.floor(now / 86_400_000);
    if (this.day && dayNumber === this.dayNumber) {
      this.day.coveredEnd = now;
      return this.day;
    }
    if (this.day && dayNumber > this.dayNumber) {
      this.day.coveredEnd = (this.dayNumber + 1) * 86_400_000;
    }
    this.dayNumber = dayNumber;
    // UTC dates make captures joinable across hosts with different local time zones.
    const date = new Date(now).toISOString().slice(0, 10);
    const prior = new Date(now - 86_400_000).toISOString().slice(0, 10);
    for (const key of this.days.keys()) {
      if (key !== date && key !== prior) this.days.delete(key);
    }
    let day = this.days.get(date);
    if (!day) {
      day = {
        date,
        coveredStart: now,
        coveredEnd: now,
        totals: trafficTotals(),
        types: new Map(),
        transports: new Map(),
        acceptedFrameTransports: new Map(),
      };
      this.days.set(date, day);
    }
    day.coveredEnd = now;
    this.day = day;
    return day;
  }

  private expireClients(now: number): void {
    for (const [key, client] of this.clients) {
      if (now - client.lastSeenAt < TRAFFIC_RETENTION_MS) break;
      this.clients.delete(key);
      this.clientEvictions++;
    }
  }
}

export function outboundTrafficType(message: WSOutboundMessage): string {
  if (message.type !== "session") return message.type;
  if (message.message.type !== "agent_stream") return `session:${message.message.type}`;
  const event = message.message.payload.event;
  const subtype = event.type === "timeline" ? `timeline:${event.item.type}` : event.type;
  return `session:agent_stream:${subtype}`;
}

function volume(): TrafficVolume {
  return { count: 0, bytes: 0 };
}

function addVolume(target: TrafficVolume, bytes: number): void {
  target.count++;
  target.bytes += bytes;
}

function addBytes<TKey>(map: Map<TKey, number>, key: TKey, bytes: number): void {
  map.set(key, (map.get(key) ?? 0) + bytes);
}

function physicalTotals(): Record<PhysicalTrafficOutcome, TrafficVolume> {
  return {
    attempted: volume(),
    rejected: volume(),
    accepted: volume(),
    completed: volume(),
    failed: volume(),
    completionUnknown: volume(),
  };
}

function trafficTotals(): TrafficTotals {
  return {
    logicalAttempts: volume(),
    fulfilled: volume(),
    rejectedOrFailed: volume(),
    synchronousRejection: volume(),
    physicalFrames: physicalTotals(),
    routedFrames: physicalTotals(),
    publications: 0,
    recipientCandidates: 0,
    rejectedBeforeSerialization: 0,
  };
}

function topBytes(map: Map<string, number>) {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    top: sorted.slice(0, 12),
    other: sorted.slice(12).reduce((sum, [, bytes]) => sum + bytes, 0),
  };
}
