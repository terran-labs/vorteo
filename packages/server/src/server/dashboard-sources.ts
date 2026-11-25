import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const run = promisify(execFile);
const repository = z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i);
const configSchema = z.object({
  repositories: z.array(repository).max(64).default([]),
  factories: z.array(repository).max(32).default([]),
  newsletter: z
    .object({ listId: z.number().int().positive(), apiKeyFile: z.string().min(1) })
    .optional(),
  syn3h: z
    .object({ accountId: z.string().regex(/^[0-9a-f]{32}$/i), tokenFile: z.string().min(1) })
    .optional(),
});
type Sources = z.infer<typeof configSchema>;
type Values = Record<string, number>;
const factoryLabels =
  'label:"factory:ready","factory:running","factory:blocked","factory:human-review"';
const searchResult = z.object({
  issueCount: z.number(),
  nodes: z.array(z.object({ createdAt: z.string().datetime() })).optional(),
});

async function github(repo: string, factory: boolean, now: Date): Promise<Values> {
  const [owner, name] = repo.split("/");
  const base = "repo:" + repo + " is:issue " + factoryLabels;
  const day = now.toISOString().slice(0, 10);
  const search = (q: string, oldest = false) =>
    "search(type:ISSUE,first:1,query:" +
    JSON.stringify(base + " " + q) +
    "){issueCount" +
    (oldest ? " nodes{... on Issue{createdAt}}" : "") +
    "}";
  const query =
    "query { repository(owner:" +
    JSON.stringify(owner) +
    ",name:" +
    JSON.stringify(name) +
    "){releases{totalCount}}" +
    (factory
      ? " open:" +
        search("is:open sort:created-asc", true) +
        " closed:" +
        search("is:closed closed:" + day) +
        " arrivals:" +
        search("created:" + day)
      : "") +
    "}";
  const { stdout } = await run(
    "gh",
    ["api", "--hostname", "github.com", "graphql", "-f", "query=" + query],
    { timeout: 15_000, maxBuffer: 256_000 },
  );
  const data = z
    .object({
      data: z.object({
        repository: z.object({ releases: z.object({ totalCount: z.number() }) }),
        open: searchResult.optional(),
        closed: searchResult.optional(),
        arrivals: searchResult.optional(),
      }),
    })
    .parse(JSON.parse(stdout)).data;
  const result: Values = { ["releases:" + repo]: data.repository.releases.totalCount };
  if (data.open && data.closed && data.arrivals) {
    result["open:" + repo] = data.open.issueCount;
    result["closed:" + repo] = data.closed.issueCount;
    result["arrivals:" + repo] = data.arrivals.issueCount;
    const oldest = data.open.nodes?.[0];
    if (oldest)
      result["oldest:" + repo] = Math.floor(
        (now.getTime() - Date.parse(oldest.createdAt)) / 86_400_000,
      );
  }
  return result;
}

async function newsletter(settings: NonNullable<Sources["newsletter"]>): Promise<Values> {
  const key = (await readFile(settings.apiKeyFile, "utf8")).trim();
  const response = await fetch("https://api.brevo.com/v3/contacts/lists/" + settings.listId, {
    headers: { "api-key": key },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Brevo read failed");
  const list = z.object({ totalSubscribers: z.number() }).parse(await response.json());
  return { subscribers: list.totalSubscribers };
}

async function syn3h(settings: NonNullable<Sources["syn3h"]>, day: string): Promise<Values> {
  const token = (await readFile(settings.tokenFile, "utf8")).trim();
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
      signal: AbortSignal.timeout(15_000),
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
): Promise<string[]> {
  let config: Sources;
  try {
    config = configSchema.parse(
      JSON.parse(await readFile(path.join(home, "dashboard", "sources.json"), "utf8")),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? []
      : ["Dashboard source configuration could not be read."];
  }
  const unavailable: string[] = [];
  async function read(label: string, load: () => Promise<Values>) {
    try {
      Object.assign(values, await load());
    } catch {
      unavailable.push(label + " unavailable at this observation.");
    }
  }
  const integrations = [
    config.newsletter && read("Newsletter", () => newsletter(config.newsletter!)),
    config.syn3h && read("Syn3h", () => syn3h(config.syn3h!, now.toISOString().slice(0, 10))),
  ];
  const repos = [...new Set([...config.repositories, ...config.factories])];
  for (let i = 0; i < repos.length; i += 3) {
    await Promise.all(
      repos
        .slice(i, i + 3)
        .map((repo) => read(repo, () => github(repo, config.factories.includes(repo), now))),
    );
  }
  await Promise.all(integrations);
  return unavailable;
}
