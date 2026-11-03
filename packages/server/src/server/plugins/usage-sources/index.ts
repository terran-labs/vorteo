import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentUsageSession } from "../../agent/agent-sdk-types.js";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { Logger } from "pino";
import {
  UsageReportSchema,
  type ProviderUsage,
  type UsageReportEntry,
  type UsageProblem,
  type UsageReport,
} from "@getpaseo/protocol/messages";

export interface UsageSource {
  id: string;
  label: string;
  icon?: string;
  discover(scope: UsageScope): Promise<unknown>;
  fetch(input: unknown): Promise<unknown>;
}

interface Login {
  input: unknown;
  harness: string;
}

interface KnownReport {
  source: UsageSource;
  logins: [Login, ...Login[]];
  label?: string;
}

export interface AgentUsageLookup {
  hasAgent(id: string): boolean;
  usageSession(id: string): AgentUsageSession | null;
}

export interface ListUsageReportsOptions {
  forceRefresh?: boolean;
  reportIds?: string[];
  agentId?: string;
  onReport?: (report: UsageReportEntry) => void;
}

interface AgentReports {
  provider: string;
  model?: string;
  sessionKey: string;
  reports: Map<string, KnownReport>;
}

/** Owns account identity, ordered logins for each account, and the five-minute fetch cache. */
export class UsageSourceRegistry {
  private readonly sources = new Map<string, UsageSource>();
  private readonly known = new Map<string, KnownReport>();
  private defaults = new Map<string, KnownReport>();
  private readonly byAgent = new Map<string, AgentReports>();
  private readonly cache = new Map<string, { at: number; entry: UsageReportEntry }>();
  private readonly successful = new Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>();
  /**
   * Readings saved by an earlier daemon. Discovery after a restart has not rebuilt every
   * identity yet, so these sit outside pruning and stand in until a fresh success replaces them.
   */
  private readonly restored = new Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>();
  /** Settles once the saved readings are loaded; fetches wait on it before consulting them. */
  private readonly restoring: Promise<void>;
  /** Serializes saves so an older write never lands after a newer one. */
  private saving: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Promise<UsageReportEntry>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 300_000,
    private readonly logger: Pick<Logger, "warn"> = { warn: console.warn },
    private readonly agents: AgentUsageLookup = { hasAgent: () => false, usageSession: () => null },
    private readonly deadlineMs = 20_000,
    /** Where the last good readings persist across restarts; in memory only when absent. */
    private readonly snapshotPath?: string,
  ) {
    this.restoring = this.restore(snapshotPath);
  }

  register(source: UsageSource): void {
    if (this.sources.has(source.id)) throw new Error(`Duplicate usage source: ${source.id}`);
    this.sources.set(source.id, source);
  }

  unregister(id: string): void {
    this.sources.delete(id);
    for (const key of this.defaults.keys()) if (key.startsWith(`${id}:`)) this.defaults.delete(key);
    // Re-discover on the next session query when a source is replaced.
    for (const [agentId, mapping] of this.byAgent) {
      if ([...mapping.reports.values()].some((report) => report.source.id === id))
        this.byAgent.delete(agentId);
    }
    for (const key of this.known.keys()) if (key.startsWith(`${id}:`)) this.known.delete(key);
    for (const key of this.cache.keys()) if (key.startsWith(`${id}:`)) this.cache.delete(key);
    for (const key of this.successful.keys())
      if (key.startsWith(`${id}:`)) this.successful.delete(key);
    for (const key of this.pending.keys()) if (key.startsWith(`${id}:`)) this.pending.delete(key);
  }

  async listReports(options: ListUsageReportsOptions = {}): Promise<UsageReportEntry[]> {
    if (options.agentId !== undefined && options.reportIds !== undefined)
      throw new Error("agentId and reportIds cannot be combined");
    this.pruneAgents();
    let ids: string[];
    let reports = this.known;
    if (options.agentId !== undefined) {
      ids = await this.discoverAgent(options.agentId);
      reports = this.byAgent.get(options.agentId)?.reports ?? new Map();
    } else if (options.reportIds !== undefined) {
      ids = options.reportIds;
    } else {
      this.defaults = await this.discover({ kind: "global" }, this.defaults);
      this.mergeKnown();
      ids = [...this.known.keys()];
    }
    return Promise.all(
      [...new Set(ids)].flatMap((id) => {
        const known = reports.get(id);
        if (!known) return [];
        return [
          this.fetchId(id, known, options.forceRefresh).then((entry) => {
            options.onReport?.(entry);
            return entry;
          }),
        ];
      }),
    );
  }

  private pruneAgents(): void {
    for (const id of this.byAgent.keys()) {
      if (!this.agents.hasAgent(id)) this.byAgent.delete(id);
    }
    this.mergeKnown();
  }

  private async discoverAgent(agentId: string): Promise<string[]> {
    if (!this.agents.hasAgent(agentId)) throw new Error(`Unknown agent: ${agentId}`);
    const session = this.agents.usageSession(agentId);
    if (!session) {
      this.byAgent.delete(agentId);
      this.mergeKnown();
      return [];
    }
    const previous = this.byAgent.get(agentId);
    const sameScope =
      previous?.sessionKey === session.sessionKey &&
      previous.provider === session.provider &&
      previous.model === session.model;
    if (sameScope) return [...previous.reports.keys()];
    const reports = await this.discover({
      kind: "session",
      provider: session.provider,
      model: session.model,
      env: session.env,
    });
    // A query that finishes after a resume must not publish the previous launch's mapping.
    if (this.agents.usageSession(agentId)?.sessionKey !== session.sessionKey) return [];
    this.byAgent.set(agentId, {
      sessionKey: session.sessionKey,
      provider: session.provider,
      model: session.model,
      reports,
    });
    this.mergeKnown();
    return [...reports.keys()];
  }

  private mergeKnown(): void {
    this.known.clear();
    for (const reports of [
      this.defaults,
      ...[...this.byAgent.values()].map((agent) => agent.reports),
    ]) {
      for (const [id, report] of reports) {
        if (this.sources.get(report.source.id) !== report.source) continue;
        const known = this.known.get(id);
        if (!known) {
          this.known.set(id, { ...report, logins: [...report.logins] });
          continue;
        }
        for (const login of report.logins) {
          if (!known.logins.some((existing) => loginKey(existing) === loginKey(login)))
            known.logins.push(login);
        }
      }
    }
    // Fetch freshness expires independently of successful snapshots. Retain only live identities.
    const active = this.activeCacheKeys();
    for (const key of this.successful.keys()) {
      if (active.has(key)) continue;
      this.successful.delete(key);
      // An identity seen live and then retired drops its saved reading too.
      this.restored.delete(key);
    }
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
  }

  private activeCacheKeys(): Set<string> {
    return new Set(
      [
        this.known,
        this.defaults,
        ...[...this.byAgent.values()].map((agent) => agent.reports),
      ].flatMap((reports) => [...reports].map(([id, report]) => cacheIdentity(id, report))),
    );
  }

  private async discover(
    scope: UsageScope,
    previous: ReadonlyMap<string, KnownReport> = new Map(),
  ): Promise<Map<string, KnownReport>> {
    const discovered = await Promise.all(
      [...this.sources.values()].map(async (source) => {
        const reports = new Map<string, KnownReport>();
        try {
          const accounts = z
            .array(
              z.object({
                key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
                label: z.string().optional(),
                harness: z.string().min(1).optional(),
                input: z.json(),
              }),
            )
            .parse(await source.discover(scope));
          for (const account of accounts) {
            const id = `${source.id}:${account.key}`;
            const known = reports.get(id);
            // COMPAT(usageLoginHarness): added in v0.11.0, remove after 2027-04-05 once plugin floor >= v0.11.0.
            const login = { input: account.input, harness: account.harness ?? source.label };
            if (known) {
              if (!known.logins.some((existing) => loginKey(existing) === loginKey(login)))
                known.logins.push(login);
            } else reports.set(id, { source, logins: [login], label: account.label });
          }
        } catch (error) {
          this.logger.warn({ sourceId: source.id, err: error }, "Usage source discovery failed");
          // A failed store read does not confirm removal. Session discovery has no previous
          // mapping because a resumed agent may use a different launch environment.
          for (const [id, report] of previous) {
            if (report.source === source) reports.set(id, report);
          }
        }
        return reports;
      }),
    );
    const merged = new Map<string, KnownReport>();
    for (const reports of discovered) {
      for (const [id, report] of reports) merged.set(id, report);
    }
    return merged;
  }

  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
  async listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }> {
    const reports = await this.listReports();
    return {
      fetchedAt: reports.length
        ? reports.reduce(
            (oldest, entry) => (entry.fetchedAt < oldest ? entry.fetchedAt : oldest),
            reports[0]!.fetchedAt,
          )
        : new Date(this.now()).toISOString(),
      providers: reports.map((entry) => ({
        providerId: entry.sourceId,
        displayName: entry.account.label
          ? `${entry.sourceLabel} (${entry.account.label})`
          : entry.sourceLabel,
        status: entry.report.status,
        planLabel: entry.report.status === "available" ? (entry.report.planLabel ?? null) : null,
        windows: entry.report.status === "available" ? entry.report.windows : [],
        balances: entry.report.status === "available" ? (entry.report.balances ?? []) : [],
        details: entry.report.status === "available" ? (entry.report.details ?? []) : [],
        error: legacyError(entry.report, this.now()),
      })),
    };
  }

  private fetchId(id: string, known: KnownReport, forceRefresh = false): Promise<UsageReportEntry> {
    // Account identity groups cards; the ordered login set identifies a fetch result.
    const cacheKey = cacheIdentity(id, known);
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && this.now() - cached.at < this.ttlMs)
      return Promise.resolve(cached.entry);
    const pending = this.pending.get(cacheKey);
    if (pending) return pending;
    const request = (async () => {
      const fetchedAt = new Date(this.now()).toISOString();
      const outcome = await this.fetchWithFallback(known);
      await this.restoring;
      const completedAt = new Date(this.now()).toISOString();
      const entry: UsageReportEntry = {
        id,
        sourceId: known.source.id,
        sourceLabel: known.source.label,
        icon: known.source.icon,
        account: { label: known.label },
        fetchedAt,
        ...outcome,
      };
      if (entry.report.status === "available") {
        entry.successfulAt = completedAt;
      } else {
        entry.lastSuccessful = this.successful.get(cacheKey) ?? this.restored.get(cacheKey);
      }
      if (
        this.sources.get(known.source.id) === known.source &&
        this.activeCacheKeys().has(cacheKey)
      ) {
        if (entry.report.status === "available") {
          const snapshot = { fetchedAt: completedAt, report: entry.report };
          // Re-inserted so the oldest readings sit first when the file is trimmed.
          this.successful.delete(cacheKey);
          this.successful.set(cacheKey, snapshot);
          this.restored.delete(cacheKey);
          this.saveSnapshots();
        }
        this.writeCache(cacheKey, entry);
      }
      return entry;
    })();
    this.pending.set(cacheKey, request);
    void request.finally(() => {
      if (this.pending.get(cacheKey) === request) this.pending.delete(cacheKey);
    });
    return request;
  }

  /** Rewrites the saved readings whole, through a temporary file so a crash never truncates it. */
  private saveSnapshots(): void {
    if (!this.snapshotPath) return;
    // Restored readings not yet refreshed come first, so they are trimmed before live ones.
    const readings = [...this.restored, ...this.successful].slice(-SNAPSHOT_LIMIT);
    const path = this.snapshotPath;
    const contents = JSON.stringify({ version: 1, readings: Object.fromEntries(readings) });
    const temporary = `${path}.${process.pid}.tmp`;
    this.saving = this.saving.then(() => this.writeSnapshots(path, temporary, contents));
  }

  private async restore(path: string | undefined): Promise<void> {
    const readings = await readSnapshots(path, this.logger);
    // A success recorded while loading is newer than anything saved.
    for (const [key, reading] of readings)
      if (!this.successful.has(key)) this.restored.set(key, reading);
  }

  private async writeSnapshots(path: string, temporary: string, contents: string): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      this.logger.warn({ err: error }, "Could not save usage readings");
    }
  }

  /** Settles once every save requested so far has been written. */
  flushSaves(): Promise<void> {
    return this.saving;
  }

  private writeCache(id: string, entry: UsageReportEntry): void {
    const at = this.now();
    for (const [cachedId, cached] of this.cache) {
      if (at - cached.at >= this.ttlMs) this.cache.delete(cachedId);
    }
    this.cache.set(id, { at, entry });
  }

  private async fetchBeforeDeadline(source: UsageSource, input: unknown): Promise<UsageReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UsageReport>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "error", error: "Usage fetch timed out" }),
        this.deadlineMs,
      );
    });
    try {
      return await Promise.race([this.fetchLogin(source, input), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithFallback(
    known: KnownReport,
  ): Promise<Pick<UsageReportEntry, "report" | "loginErrors">> {
    // Start each login within the same deadline window, then prefer discovery order.
    // Sequential deadlines can exceed the client's RPC timeout before all errors arrive.
    const attempts = known.logins.map((login) =>
      this.fetchBeforeDeadline(known.source, login.input),
    );
    const loginErrors: NonNullable<UsageReportEntry["loginErrors"]> = [];
    for (const [index, login] of known.logins.entries()) {
      const report = await attempts[index]!;
      if (report.status === "available") return { report };
      loginErrors.push({ harness: login.harness, report });
    }
    // COMPAT(usageLoginErrors): added in v0.11.0, remove after 2027-04-05 once app floor >= v0.11.0.
    // Keep the final single report so older apps still parse and display failed accounts.
    return { report: loginErrors[loginErrors.length - 1]!.report, loginErrors };
  }

  private async fetchLogin(source: UsageSource, input: unknown): Promise<UsageReport> {
    try {
      return UsageReportSchema.parse(await source.fetch(input));
    } catch (error) {
      this.logger.warn({ sourceId: source.id, err: error }, "Usage fetch failed");
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// The legacy RPC has only an error string; the current app owns its own presentation.
// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyProblem(problem: UsageProblem, now: number): string {
  if (problem.kind === "no_quota") return problem.detail;
  const remedy = problem.refreshedBy
    ? `Run ${problem.refreshedBy} to refresh it.`
    : "Sign in again.";
  if (problem.kind === "rejected") return `Login rejected (HTTP ${problem.status}). ${remedy}`;
  const elapsed = Math.max(0, now - Date.parse(problem.expiresAt));
  let ago = "just now";
  if (elapsed >= 86_400_000) ago = `${Math.floor(elapsed / 86_400_000)}d ago`;
  else if (elapsed >= 3_600_000) ago = `${Math.floor(elapsed / 3_600_000)}h ago`;
  else if (elapsed >= 60_000) ago = `${Math.floor(elapsed / 60_000)}m ago`;
  return `Login expired ${ago}. ${remedy}`;
}

// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyError(report: UsageReport, now: number): string | null {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return legacyProblem(report.problem, now);
  return null;
}

// Inputs are opaque JSON locators. Canonical equality deduplicates discovery across scopes.
function loginKey(login: Login): string {
  return JSON.stringify(login, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

/** Bounds the saved file; the oldest readings go first. */
const SNAPSHOT_LIMIT = 200;

const SavedSnapshotsSchema = z.object({
  version: z.literal(1),
  readings: z.record(z.string(), z.object({ fetchedAt: z.string(), report: z.unknown() })),
});

async function readSnapshots(
  path: string | undefined,
  logger: Pick<Logger, "warn">,
): Promise<Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>> {
  const restored = new Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>();
  if (!path) return restored;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return restored;
  }
  try {
    const saved = SavedSnapshotsSchema.parse(JSON.parse(raw));
    for (const [key, reading] of Object.entries(saved.readings)) {
      const report = UsageReportSchema.safeParse(reading.report);
      if (report.success && report.data.status === "available")
        restored.set(key, { fetchedAt: reading.fetchedAt, report: report.data });
    }
  } catch (error) {
    logger.warn({ err: error, path }, "Ignoring unreadable saved usage readings");
  }
  return restored;
}

function cacheIdentity(id: string, known: KnownReport): string {
  return `${id}:${createHash("sha256")
    .update(JSON.stringify([known.label, known.logins.map(loginKey)]))
    .digest("hex")}`;
}
