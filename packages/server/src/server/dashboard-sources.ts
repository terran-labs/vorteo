import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { collectNewsletter } from "./dashboard-newsletter.js";
import { readDashboardFactory } from "./dashboard-factory.js";

const run = promisify(execFile);
const repositorySchema = z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i);
const configSchema = z.object({
  repositories: z.array(repositorySchema).max(64).default([]),
  factories: z.array(repositorySchema).max(32).default([]),
  newsletter: z
    .object({
      listId: z.number().int().positive(),
      apiKeyFile: z.string().min(1),
      sourceNames: z
        .array(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,119}$/i))
        .max(64)
        .optional(),
    })
    .optional(),
  syn3h: z
    .object({ accountId: z.string().regex(/^[0-9a-f]{32}$/i), tokenFile: z.string().min(1) })
    .optional(),
});
type Sources = z.infer<typeof configSchema>;
type Values = Record<string, number>;
async function github(repo: string, signal: AbortSignal): Promise<Values> {
  const [owner, name] = repo.split("/");
  const query =
    "query { repository(owner:" +
    JSON.stringify(owner) +
    ",name:" +
    JSON.stringify(name) +
    "){releases{totalCount}}}";
  const { stdout } = await run(
    "gh",
    ["api", "--hostname", "github.com", "graphql", "-f", "query=" + query],
    { timeout: 15_000, maxBuffer: 256_000, signal },
  );
  const data = z
    .object({
      data: z.object({
        repository: z.object({ releases: z.object({ totalCount: z.number() }) }),
      }),
    })
    .parse(JSON.parse(stdout)).data;
  return { ["releases:" + repo]: data.repository.releases.totalCount };
}

async function syn3h(input: {
  settings: NonNullable<Sources["syn3h"]>;
  day: string;
  signal: AbortSignal;
  unavailable: string[];
}): Promise<Values> {
  const { settings, day, signal } = input;
  const token = (await readFile(settings.tokenFile, { encoding: "utf8", signal })).trim();
  const url =
    "https://api.cloudflare.com/client/v4/accounts/" + settings.accountId + "/analytics_engine/sql";
  const numeric = z
    .union([z.string().min(1), z.number()])
    .transform(Number)
    .pipe(z.number().finite());
  async function query(sql: string) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: sql,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Syn3h read failed");
    return z
      .object({ data: z.array(z.record(z.string(), z.unknown())) })
      .parse(await response.json()).data;
  }
  const since = "blob2 = 'production' AND timestamp >= toDateTime('" + day + " 00:00:00')";
  const [events, players, presence, cohort] = await Promise.all([
    query(
      "SELECT blob1 AS event, SUM(_sample_interval) AS events, SUM(double1 * _sample_interval) AS seconds, SUM(double2 * _sample_interval) AS activeSeconds, SUM(double4 * _sample_interval) AS rejoins FROM mira_events WHERE " +
        since +
        " GROUP BY event FORMAT JSON",
    ),
    query(
      "SELECT blob10 AS aid FROM mira_events WHERE blob1 = 'session_start' AND blob10 != '' AND " +
        since +
        " GROUP BY aid LIMIT 100000 FORMAT JSON",
    ),
    query(
      "SELECT toStartOfMinute(timestamp) AS minute, SUM(double5 * _sample_interval) AS connected FROM mira_events WHERE blob1 = 'presence' AND " +
        since +
        " GROUP BY minute FORMAT JSON",
    ),
    query(
      "SELECT blob10 AS aid, MIN(timestamp) AS firstSeen FROM mira_events WHERE blob1 = 'session_start' AND blob2 = 'production' AND blob10 != '' GROUP BY aid LIMIT 100000 FORMAT JSON",
    ),
  ]);
  // Never persist player identifiers. Suppress cohort metrics if the result reached its cap.
  const daySeven = new Date(Date.parse(day) - 7 * 86_400_000).toISOString().slice(0, 10);
  const active = new Set(players.map((row) => z.string().parse(row.aid)));
  const values: Values = {};
  if (players.length >= 100000)
    input.unavailable.push("Syn3h daily player and retention counts exceeded the query limit.");
  else if (cohort.length >= 100000)
    input.unavailable.push("Syn3h retention counts exceeded the first-seen query limit.");
  if (players.length < 100000) {
    values.synPlayers = active.size;
  }
  if (players.length < 100000 && cohort.length < 100000) {
    let eligible = 0;
    let returned = 0;
    let returningToday = 0;
    for (const row of cohort) {
      const first = z.string().parse(row.firstSeen).slice(0, 10);
      const isActive = active.has(z.string().parse(row.aid));
      if (isActive && first < day) returningToday++;
      if (first === daySeven) {
        eligible++;
        if (isActive) returned++;
      }
    }
    values.synReturning = returningToday;
    values.synCohort = eligible;
    if (eligible > 0) values.synD7 = (100 * returned) / eligible;
  }
  const byEvent = new Map(events.map((row) => [row.event, row]));
  function sum(event: string, field: string) {
    const row = byEvent.get(event);
    return row ? numeric.parse(row[field]) : 0;
  }
  return {
    ...values,
    synSessions: sum("session_start", "events"),
    synMinutes: sum("session_end", "activeSeconds") / 60,
    synPlayMinutes: sum("session_end", "seconds") / 60,
    synRejoins: sum("session_end", "rejoins"),
    synRoomFull: sum("room_full", "events"),
    synCrashes: sum("crash", "events"),
    synPeak: presence.reduce((peak, row) => Math.max(peak, numeric.parse(row.connected)), 0),
  };
}

export async function collectDashboardSources(
  home: string,
  now: Date,
  values: Values,
  signal: AbortSignal,
  projects: readonly { projectId: string; archivedAt: string | null }[] = [],
): Promise<string[]> {
  let config: Sources = { repositories: [], factories: [] };
  const unavailable: string[] = [];
  try {
    config = configSchema.parse(
      JSON.parse(
        await readFile(path.join(home, "dashboard", "sources.json"), { encoding: "utf8", signal }),
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      unavailable.push("Dashboard source configuration could not be read.");
  }
  async function read(label: string, load: () => Promise<Values>) {
    if (signal.aborted) return;
    try {
      Object.assign(values, await load());
    } catch {
      if (!signal.aborted) unavailable.push(label + " unavailable at this observation.");
    }
  }
  async function readRepositories() {
    const repos = [...new Set([...config.repositories, ...config.factories])];
    for (let i = 0; i < repos.length && !signal.aborted; i += 3) {
      await Promise.all(
        repos.slice(i, i + 3).map((repo) => read(repo, () => github(repo, signal))),
      );
    }
  }
  const { newsletter: newsletterSettings, syn3h: syn3hSettings } = config;
  const day = now.toISOString().slice(0, 10);
  async function factories() {
    const report = await readDashboardFactory({
      paseoHome: home,
      projects,
      now,
      since: new Date(day + "T00:00:00Z"),
      queueMaxAgeMs: 3_600_000,
      signal,
    });
    if (report.status === "unavailable") {
      unavailable.push("Factory registry unavailable.");
      return;
    }
    for (const project of report.projects) {
      const { stages, repository } = project;
      if (stages.status === "observed" && !stages.stale && !stages.partial) {
        for (const [stage, count] of Object.entries(stages.counts))
          values[`factory-${stage}:${repository}`] = count;
      } else {
        unavailable.push(
          stages.status === "observed"
            ? `${repository} Factory queue is stale or incomplete (observed ${stages.fetchedAt}).`
            : `${repository} Factory queue unavailable.`,
        );
      }
      const oldest = project.oldestOpenIssue;
      if (oldest.status === "complete") values["oldestOpenDays:" + repository] = oldest.ageDays;
      if (oldest.status === "unavailable")
        unavailable.push(repository + " oldest open ticket age unavailable.");
      const labels = {
        qualifiedMerges: "Factory merges",
        issueClosures: "Factory closures",
        firstAdmissions: "First Factory label admissions",
      };
      for (const metric of ["qualifiedMerges", "issueClosures", "firstAdmissions"] as const) {
        const history = project[metric];
        if (history.status === "complete") values[metric + ":" + repository] = history.count;
        else unavailable.push(repository + " " + labels[metric] + " unavailable.");
      }
    }
  }
  if (!newsletterSettings) unavailable.push("Newsletter read credentials are not configured.");
  if (!syn3hSettings) unavailable.push("Syn3h read credentials are not configured.");
  await Promise.all([
    newsletterSettings && read("Newsletter", () => collectNewsletter(newsletterSettings, signal)),
    syn3hSettings &&
      read("Syn3h", () => syn3h({ settings: syn3hSettings, day, signal, unavailable })),
    readRepositories(),
    factories(),
  ]);
  signal.throwIfAborted();
  return unavailable;
}
