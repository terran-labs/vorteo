import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  DEFAULT_UPDATE_POLICY,
  ReleaseTagSchema,
  UpdatePolicySchema,
  type AgentUpdateStatus,
  type ReleaseNotes,
  type UpdateChannel,
  type UpdateCheck,
  type UpdatePolicy,
  type UpdatePolicyChange,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomic } from "../private-files.js";
import type { InstallationUpgrades } from "./release-upgrades.js";
import { VORTEO_RELEASE_REPOSITORY } from "./release-source.js";

/**
 * The installation's update policy and its update check. The check finds the newest
 * installable GitHub release on the policy's channel above the installed version and offers
 * it as one pending release upgrade, which the interface shows as an Open question. A newer
 * release replaces an unanswered offer, a release the owner declined is not offered again,
 * and under the automatic policy the offer is approved at once to install when idle.
 * Installing still runs every step of the tracked upgrade in release-upgrades.ts.
 */

const PolicyFileSchema = z.strictObject({ version: z.literal(1), policy: UpdatePolicySchema });

export interface UpdatePolicyStore {
  read(): Promise<UpdatePolicy>;
  write(policy: UpdatePolicy): Promise<void>;
}

export function createUpdatePolicyStore(stateDir: string): UpdatePolicyStore {
  const file = path.join(stateDir, "update-policy.json");
  return {
    async read() {
      const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return text === null
        ? DEFAULT_UPDATE_POLICY
        : PolicyFileSchema.parse(JSON.parse(text)).policy;
    },
    write: (policy) =>
      writePrivateFileAtomic(file, JSON.stringify({ version: 1, policy }, null, 2)),
  };
}

/** A release as the GitHub Releases API returns it; only the fields the check reads. */
const GitHubReleaseSchema = z
  .object({
    tag_name: z.string(),
    draft: z.boolean(),
    html_url: z.string().url(),
    body: z.string().nullable().optional(),
    published_at: z.string().datetime().nullable().optional(),
    assets: z.array(z.object({ name: z.string(), state: z.string() }).passthrough()).default([]),
  })
  .passthrough();
type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

const CALENDAR = /^([1-9]\d+)\.([1-9]|1[0-2])\.([1-9]\d{2,3})$/;

function calendarRank(version: string): number[] | null {
  const match = CALENDAR.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

/** Positive when left is newer. A version that is not a calendar version sorts below all. */
function compareVersions(left: string, right: string): number {
  const a = calendarRank(left);
  const b = calendarRank(right);
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  const index = a.findIndex((value, position) => value !== b[position]);
  return index === -1 ? 0 : a[index]! - b[index]!;
}

function parseTag(tag: string): { version: string; channel: UpdateChannel } | null {
  if (!ReleaseTagSchema.safeParse(tag).success) return null;
  const version = tag.slice("release-".length);
  return version.endsWith("-beta")
    ? { version: version.slice(0, -"-beta".length), channel: "beta" }
    : { version, channel: "stable" };
}

/**
 * The newest installable release on the channel whose version is above the installed one.
 * Installable matches scripts/release/latest.mjs: published, not a draft, with install.sh.
 * Beta follows both kinds of tag; a stable tag on the same version as a beta is the same code.
 */
export function newestRelease(
  releases: readonly GitHubRelease[],
  channel: UpdateChannel,
  installedVersion: string | null,
): GitHubRelease | null {
  let best: { release: GitHubRelease; version: string; stable: boolean } | null = null;
  for (const release of releases) {
    const tag = parseTag(release.tag_name);
    if (!tag || release.draft) continue;
    if (channel === "stable" && tag.channel !== "stable") continue;
    if (!release.assets.some((asset) => asset.name === "install.sh" && asset.state === "uploaded"))
      continue;
    if (installedVersion && compareVersions(tag.version, installedVersion) <= 0) continue;
    const order = best ? compareVersions(tag.version, best.version) : 1;
    // Prefer the stable tag when both name one version: it is what a beta became.
    if (order > 0 || (order === 0 && tag.channel === "stable" && !best?.stable))
      best = { release, version: tag.version, stable: tag.channel === "stable" };
  }
  return best?.release ?? null;
}

const SUMMARY_LIMIT = 600;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sections(body: string): { heading: string | null; lines: string[] }[] {
  const result: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) result.push({ heading: plain(heading[1] ?? ""), lines: [] });
    else result.at(-1)!.lines.push(line);
  }
  return result;
}

/**
 * Reads a release's notes, written as docs/release.md#public-release-summaries describes: an
 * outcome summary first, a "Security" section when the release fixes a vulnerability, and a
 * "Factory charter changes" section listing changed charters.
 */
export function readReleaseNotes(release: GitHubRelease): ReleaseNotes {
  const body = release.body ?? "";
  const parts = sections(body);
  const firstParagraph = (lines: string[]) =>
    lines
      .join("\n")
      .split(/\n\s*\n/)
      .map((paragraph) => plain(paragraph.replace(/^\s*[-*+]\s+/gm, "")))
      .find(Boolean) ?? "";
  const summaryText =
    firstParagraph(parts[0]!.lines) ||
    parts.map((part) => firstParagraph(part.lines)).find(Boolean) ||
    "";
  const summary =
    summaryText.length > SUMMARY_LIMIT
      ? `${summaryText.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`
      : summaryText;
  const charter = parts.find((part) => /^factory charter changes$/i.test(part.heading ?? ""));
  const charterChanges =
    charter?.lines
      .map((line) => /^\s*[-*+]\s+(.*)$/.exec(line)?.[1])
      .filter((item): item is string => Boolean(item))
      .map(plain)
      .filter((item) => item && !/^none\.?$/i.test(item)) ?? [];
  return {
    summary,
    security: parts.some((part) => /^security\b/i.test(part.heading ?? "")),
    charterChanges,
    url: release.html_url,
    ...(release.published_at ? { publishedAt: release.published_at } : {}),
  };
}

export interface ReleaseUpdatePorts {
  now(): Date;
  /** The newest releases of the repository, newest first. */
  listReleases(): Promise<GitHubRelease[]>;
  /** The installed Host source version, or null when unknown. */
  installedVersion(): string | null;
}

/** Reads releases from the public GitHub API without a token, as scripts/release/latest.mjs does. */
export async function fetchGitHubReleases(
  fetchImpl: typeof fetch = fetch,
  repository = VORTEO_RELEASE_REPOSITORY,
): Promise<GitHubRelease[]> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases?per_page=50`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "vorteo-installation-coordinator",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 403 || response.status === 429
        ? "GitHub rate-limited the update check. It retries within the hour."
        : `GitHub answered the update check with HTTP ${response.status}.`,
    );
  return z.array(GitHubReleaseSchema).parse(await response.json());
}

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "vorteo-installation-coordinator",
  "X-GitHub-Api-Version": "2022-11-28",
};

const RulesetSchema = z.object({
  rules: z.array(
    z.object({
      type: z.string(),
      parameters: z
        .object({
          required_status_checks: z
            .array(z.object({ context: z.string(), integration_id: z.number().optional() }))
            .optional(),
        })
        .passthrough()
        .optional(),
    }),
  ),
});

const CheckRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ id: z.number() }).nullable().optional(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

/** Required check names and their one app, from `.github/rulesets/main.json` at the commit. */
export function requiredChecksOf(rulesetText: string): { names: string[]; app: number } {
  const ruleset = RulesetSchema.parse(JSON.parse(rulesetText));
  const checks =
    ruleset.rules.find((rule) => rule.type === "required_status_checks")?.parameters
      ?.required_status_checks ?? [];
  // An empty list is a configuration error, never a pass.
  if (!checks.length) throw new Error("The main ruleset lists no required checks.");
  const apps = new Set(checks.map((check) => check.integration_id));
  const [app] = [...apps];
  if (apps.size !== 1 || app === undefined)
    throw new Error("The main ruleset's required checks do not name one app.");
  return { names: checks.map((check) => check.context), app };
}

/** CI's `changes` job decides through its path filter whether these checks run. */
const PATH_FILTER_GATE = "changes";
const PATH_FILTERED_CHECKS = new Set(["format", "lint", "typecheck"]);

/**
 * Whether every required check passed on one commit, as scripts/lib/github.mjs judges it for
 * publication: the newest run per name decides and only success passes, except that a
 * path-filtered check skipped beside a passing `changes` counts. Runs from other apps are
 * ignored, so nothing but the ruleset's app can satisfy a check.
 */
export function summarizeRequiredChecks(
  runs: readonly CheckRun[],
  required: { names: readonly string[]; app: number },
): { passed: boolean; detail: string } {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    if (run.app?.id !== required.app) continue;
    const previous = latest.get(run.name);
    if (!previous || run.id > previous.id) latest.set(run.name, run);
  }
  const gate = latest.get(PATH_FILTER_GATE);
  const gatePassed = gate?.status === "completed" && gate.conclusion === "success";
  const pending: string[] = [];
  const failed: string[] = [];
  for (const name of required.names) {
    const run = latest.get(name);
    if (!run || run.status !== "completed") pending.push(name);
    else if (run.conclusion === "success") continue;
    else if (run.conclusion === "skipped" && PATH_FILTERED_CHECKS.has(name) && gatePassed) continue;
    else failed.push(`${name} (${run.conclusion ?? "no result"})`);
  }
  if (failed.length) return { passed: false, detail: `failed: ${failed.join(", ")}.` };
  if (pending.length)
    return { passed: false, detail: `missing or still running: ${pending.join(", ")}.` };
  return { passed: true, detail: `${required.names.join(", ")} passed.` };
}

/** Reads a commit's check runs from the public GitHub API without a token. */
export async function fetchCheckRuns(
  commit: string,
  fetchImpl: typeof fetch = fetch,
  repository = VORTEO_RELEASE_REPOSITORY,
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  // A main push runs about 30 jobs; five pages leave ample room.
  for (let page = 1; page <= 5; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/commits/${commit}/check-runs?per_page=100&page=${page}`,
      { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new Error(
        response.status === 403 || response.status === 429
          ? "GitHub rate-limited the check-run query. Try again within the hour."
          : `GitHub answered the check-run query with HTTP ${response.status}.`,
      );
    const body = z
      .object({ total_count: z.number(), check_runs: z.array(CheckRunSchema) })
      .parse(await response.json());
    runs.push(...body.check_runs);
    if (runs.length >= body.total_count || body.check_runs.length === 0) return runs;
  }
  return runs;
}

export class ReleaseUpdates {
  private last: UpdateCheck = {
    checkedAt: null,
    error: null,
    installedVersion: null,
    latest: null,
  };
  private running: Promise<UpdateCheck> | null = null;
  private current: UpdatePolicy | null = null;

  constructor(
    private readonly store: UpdatePolicyStore,
    private readonly upgrades: InstallationUpgrades,
    private readonly ports: ReleaseUpdatePorts,
    private readonly logger?: Logger,
  ) {}

  /** The policy last read or written. The default until the first read finishes. */
  policy(): UpdatePolicy {
    return this.current ?? DEFAULT_UPDATE_POLICY;
  }

  lastCheck(): UpdateCheck {
    return this.last;
  }

  /** Reads the stored policy. An unreadable file keeps the default, which never installs. */
  async load(): Promise<UpdatePolicy> {
    try {
      this.current = await this.store.read();
    } catch (error) {
      this.logger?.warn({ err: error }, "Installation update policy is unreadable");
      this.current = DEFAULT_UPDATE_POLICY;
    }
    return this.current;
  }

  async changePolicy(change: UpdatePolicyChange): Promise<UpdatePolicy> {
    const next = UpdatePolicySchema.parse({ ...(await this.load()), ...change });
    await this.store.write(next);
    this.current = next;
    return next;
  }

  agentStatus(): AgentUpdateStatus {
    return { policy: this.policy(), check: this.last, active: this.upgrades.active() };
  }

  /** Runs one update check; concurrent callers share it. Never throws. */
  check(): Promise<UpdateCheck> {
    this.running ??= this.runCheck().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** A check that starts after any running one, so it sees a policy changed meanwhile. */
  async checkAgain(): Promise<UpdateCheck> {
    await this.running;
    return this.check();
  }

  private async runCheck(): Promise<UpdateCheck> {
    // After the first read, memory is current: a reload could undo a concurrent change.
    const policy = this.current ?? (await this.load());
    const checkedAt = this.ports.now().toISOString();
    let installedVersion: string | null = null;
    try {
      installedVersion = this.ports.installedVersion();
      // Without the installed version any release could be older code; offer nothing.
      if (installedVersion === null)
        throw new Error("The installed Host version is unknown, so no release is offered.");
      const release = newestRelease(
        await this.ports.listReleases(),
        policy.channel,
        installedVersion,
      );
      const tag = release ? parseTag(release.tag_name) : null;
      const latest =
        release && tag
          ? { release: release.tag_name, channel: tag.channel, notes: readReleaseNotes(release) }
          : null;
      this.last = { checkedAt, error: null, installedVersion, latest };
      await this.offer(latest);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ err: error }, "Installation update check failed");
      // A failed check offers nothing, so an earlier result cannot be offered from Settings.
      this.last = { checkedAt, error: detail, installedVersion, latest: null };
    }
    return this.last;
  }

  private async offer(latest: UpdateCheck["latest"]): Promise<void> {
    const active = this.upgrades.active();
    if (active?.status === "pending" && active.origin === "update-check") {
      // The offer still stands; switching to automatic approves it.
      if (active.release === latest?.release) return this.approveIfAutomatic(active.id);
      this.upgrades.withdraw(
        active.id,
        latest
          ? `Replaced by the newer release ${latest.release}.`
          : `Withdrawn: ${active.release} is no longer a newer release on this channel.`,
      );
    } else if (active) {
      // Owner requests and approved or running upgrades are left alone.
      return;
    }
    if (!latest) return;
    // One question per release: a release already declined, installed or tried is not offered
    // again. The owner can still start it from Settings.
    const seen = this.upgrades
      .list()
      .some((item) => item.release === latest.release && item.status !== "cancelled");
    if (seen) return;
    // A source upgrade or another coordinator job holds release upgrades off; the next check
    // offers the release once it ends. This is not a failed check.
    const blocked = this.upgrades.blocked();
    if (blocked) {
      this.last = { ...this.last, note: `Not offered yet: ${blocked}` };
      return;
    }
    const upgrade = await this.upgrades.request(latest.release, {
      origin: "update-check",
      notes: latest.notes,
    });
    this.logger?.info({ release: latest.release }, "Offered a release upgrade");
    this.approveIfAutomatic(upgrade.id);
  }

  /** Reads the policy as it is now, since the owner may have changed it during the fetch. */
  private approveIfAutomatic(id: string): void {
    if (this.policy().mode === "automatic" && !this.upgrades.blocked())
      this.upgrades.approveAutomatically(id);
  }
}
