import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ProjectFactoryQueueSchema,
  type ProjectFactoryQueue,
} from "@getpaseo/server/factory-project";
import { z } from "zod";
import { markerInstallations } from "./factory/project/claims.js";
import { projectFactoryStatePath, ProjectFactoryStateStore } from "./factory/project/state.js";

const run = promisify(execFile);
const repositorySchema = z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i);
const queueSnapshotSchema = z.object({
  repository: repositorySchema,
  queue: ProjectFactoryQueueSchema,
});
type Stage = ProjectFactoryQueue["issues"][number]["stage"];
type StageObservation =
  | { status: "unavailable"; reason: "missing" | "invalid" | "repository-changed" }
  | {
      status: "observed";
      fetchedAt: string;
      stale: boolean;
      partial: boolean;
      counts: Record<Stage, number>;
    };

type HistoryCount = { status: "complete" | "partial"; count: number } | { status: "unavailable" };
type OpenIssueAge =
  | { status: "complete"; oldestCreatedAt: string; ageDays: number }
  | { status: "empty" | "unavailable" };

interface QueueObservation {
  stages: StageObservation;
  openIssueNumbers: number[];
}

interface FactoryProject {
  projectId: string;
  repository: string;
  paused: boolean;
}

interface ActiveProjectRecord {
  projectId: string;
  archivedAt: string | null;
}

interface ReadFactoryOptions {
  paseoHome: string;
  projects: readonly ActiveProjectRecord[];
  now: Date;
  since: Date;
  queueMaxAgeMs: number;
  signal?: AbortSignal;
  graphql?: DashboardFactoryGraphQL;
}

interface FactoryMeasurement extends FactoryProject {
  stages: StageObservation;
  qualifiedMerges: HistoryCount;
  issueClosures: HistoryCount;
  firstAdmissions: HistoryCount;
  oldestOpenIssue: OpenIssueAge;
}

export type DashboardFactoryMeasurement =
  | { status: "available"; projects: FactoryMeasurement[] }
  | { status: "unavailable"; reason: "registry-unreadable" | "invalid-repository" };

export type DashboardFactoryGraphQL = (
  query: string,
  variables: Record<string, string>,
  signal: AbortSignal,
) => Promise<unknown>;

async function githubGraphQL(
  query: string,
  variables: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = ["api", "--hostname", "github.com", "graphql", "-f", "query=" + query];
  for (const [key, value] of Object.entries(variables)) args.push("-f", key + "=" + value);
  const { stdout } = await run("gh", args, { timeout: 10_000, maxBuffer: 2_000_000, signal });
  return JSON.parse(stdout);
}

async function readStages(
  options: ReadFactoryOptions,
  project: FactoryProject,
): Promise<QueueObservation> {
  const file = path.join(
    options.paseoHome,
    "factory",
    "queues",
    encodeURIComponent(project.projectId) + ".json",
  );
  try {
    const snapshot = queueSnapshotSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (snapshot.repository.toLowerCase() !== project.repository.toLowerCase()) {
      return {
        stages: { status: "unavailable", reason: "repository-changed" },
        openIssueNumbers: [],
      };
    }
    const queue = snapshot.queue;
    const age = options.now.getTime() - Date.parse(queue.fetchedAt);
    if (!Number.isFinite(age) || age < 0) {
      return { stages: { status: "unavailable", reason: "invalid" }, openIssueNumbers: [] };
    }
    const partial = Boolean(
      queue.partial || queue.degraded || queue.issueAgentHost?.unavailable || queue.error !== null,
    );
    const counts: Record<Stage, number> = {
      queued: 0,
      planning: 0,
      building: 0,
      review: 0,
      repair: 0,
      merging: 0,
      blocked: 0,
    };
    for (const issue of queue.issues) counts[issue.stage]++;
    const openIssueNumbers = queue.issues.map((issue) => issue.number);
    return {
      stages: {
        status: "observed",
        fetchedAt: queue.fetchedAt,
        stale: age > options.queueMaxAgeMs,
        partial,
        counts,
      },
      openIssueNumbers,
    };
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return {
      stages: { status: "unavailable", reason: missing ? "missing" : "invalid" },
      openIssueNumbers: [],
    };
  }
}

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const dateTime = z.string().datetime();
const pullRequest = z.object({
  headRefName: z.string(),
  isCrossRepository: z.boolean(),
  repository: z.object({ nameWithOwner: z.string() }),
  mergedAt: dateTime.nullable(),
});
const linkedIssue = z.object({
  number: z.number().int(),
  repository: z.object({ nameWithOwner: z.string() }),
});
const merge = pullRequest.extend({
  id: z.string(),
  body: z.string(),
  closingIssuesReferences: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(linkedIssue),
  }),
});
const closedEvent = z.object({
  createdAt: dateTime,
  closer: z.object({ __typename: z.string() }).passthrough().nullable(),
});
const reference = z.object({
  createdAt: dateTime,
  source: z.object({ __typename: z.string() }).passthrough(),
});
const issueHistorySchema = z.object({
  number: z.number().int(),
  timelineItems: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(closedEvent),
  }),
  references: z.object({
    pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    nodes: z.array(reference),
  }),
});
const mergePage = z.object({ search: z.object({ pageInfo, nodes: z.array(merge) }) });
const issuePage = z.object({
  repository: z.object({ issues: z.object({ pageInfo, nodes: z.array(issueHistorySchema) }) }),
});
const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() });
const factoryLabels = new Set([
  "factory:ready",
  "factory:running",
  "factory:blocked",
  "factory:human-review",
]);
const labelSchema = z.object({ name: z.string() });
const admissionIssue = z.object({
  number: z.number().int(),
  timelineItems: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(z.object({ createdAt: dateTime, label: labelSchema })),
  }),
});
const admissionsPage = z.object({
  repository: z.object({ issues: z.object({ pageInfo, nodes: z.array(admissionIssue) }) }),
});
const openIssueSchema = z.object({
  number: z.number().int(),
  state: z.literal("OPEN"),
  createdAt: dateTime,
  labels: z.object({ nodes: z.array(labelSchema) }),
});
const openIssuesResponse = z.object({
  repository: z.record(z.string(), openIssueSchema),
});

const pullRequestFields = "headRefName isCrossRepository repository { nameWithOwner } mergedAt";
const mergesQuery = `query($search:String!,$cursor:String) {
  search(type: ISSUE, query: $search, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      id body ${pullRequestFields}
      closingIssuesReferences(first: 20) {
        pageInfo { hasNextPage }
        nodes { number repository { nameWithOwner } }
      }
    } }
  }
}`;
const closuresQuery = `query($owner:String!,$name:String!,$since:DateTime!,$cursor:String) {
  repository(owner: $owner, name: $name) {
    issues(first: 25, after: $cursor, filterBy: {since: $since}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        timelineItems(first: 25, since: $since, itemTypes: [CLOSED_EVENT]) {
          pageInfo { hasNextPage }
          nodes { ... on ClosedEvent {
            createdAt
            closer { __typename ... on PullRequest { ${pullRequestFields} } }
          } }
        }
        references: timelineItems(last: 25, itemTypes: [CROSS_REFERENCED_EVENT]) {
          pageInfo { hasPreviousPage }
          nodes { ... on CrossReferencedEvent {
            createdAt
            source { __typename ... on PullRequest { ${pullRequestFields} } }
          } }
        }
      }
    }
  }
}`;

const admissionsQuery = `query($owner:String!,$name:String!,$since:DateTime!,$cursor:String) {
  repository(owner: $owner, name: $name) {
    issues(first: 25, after: $cursor, filterBy: {since: $since}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        timelineItems(first: 50, itemTypes: [LABELED_EVENT]) {
          pageInfo { hasNextPage }
          nodes { ... on LabeledEvent { createdAt label { name } } }
        }
      }
    }
  }
}`;

function createReader(options: ReadFactoryOptions, signal: AbortSignal) {
  const graphql = options.graphql ?? githubGraphQL;
  return async (query: string, variables: Record<string, string>, cursor?: string | null) => {
    signal.throwIfAborted();
    if (cursor) variables.cursor = cursor;
    const response = envelope.parse(await graphql(query, variables, signal));
    if (response.errors?.length) throw new Error("GitHub returned incomplete Factory evidence");
    return response.data;
  };
}

async function readOldestOpenIssue(
  options: ReadFactoryOptions,
  repository: string,
  queue: QueueObservation,
  signal: AbortSignal,
): Promise<OpenIssueAge> {
  if (queue.stages.status !== "observed" || queue.stages.stale || queue.stages.partial) {
    return { status: "unavailable" };
  }
  const numbers = [...new Set(queue.openIssueNumbers)];
  const invalidNumbers = numbers.some((number) => !Number.isSafeInteger(number) || number < 1);
  if (invalidNumbers || numbers.length > 100) return { status: "unavailable" };
  if (numbers.length === 0) return { status: "empty" };

  const [owner, name] = repository.split("/");
  const issueFields = numbers.map(
    (number) =>
      `issue${number}: issue(number:${number}) { number state createdAt labels(first:100) { nodes { name } } }`,
  );
  const query = `query($owner:String!,$name:String!) {
    repository(owner:$owner,name:$name) { ${issueFields.join(" ")} }
  }`;
  try {
    const read = createReader(options, signal);
    const response = openIssuesResponse.parse(await read(query, { owner: owner!, name: name! }));
    let oldest = options.now.getTime();
    for (const number of numbers) {
      const issue = response.repository[`issue${number}`];
      if (!issue || issue.number !== number) return { status: "unavailable" };
      const isFactoryIssue = issue.labels.nodes.some((label) => factoryLabels.has(label.name));
      const created = Date.parse(issue.createdAt);
      if (!isFactoryIssue || created > options.now.getTime()) return { status: "unavailable" };
      oldest = Math.min(oldest, created);
    }
    return {
      status: "complete",
      oldestCreatedAt: new Date(oldest).toISOString(),
      ageDays: Math.floor((options.now.getTime() - oldest) / 86_400_000),
    };
  } catch {
    return { status: "unavailable" };
  }
}

function factoryBranchIssue(pr: z.infer<typeof pullRequest>, repository: string): number | null {
  if (
    pr.isCrossRepository ||
    pr.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()
  )
    return null;
  const match = /^(?:factory\/issue-|.+\/factory-issue-)([1-9]\d*)$/.exec(pr.headRefName);
  return match ? Number(match[1]) : null;
}

function isLinkedMerge(
  source: z.infer<typeof reference>["source"] | null,
  repository: string,
  issueNumber: number,
  closedAt: string,
): boolean {
  if (source?.__typename !== "PullRequest") return false;
  const pr = pullRequest.parse(source);
  return Boolean(
    pr.mergedAt &&
    Date.parse(pr.mergedAt) <= Date.parse(closedAt) &&
    factoryBranchIssue(pr, repository) === issueNumber,
  );
}

interface HistoryPage {
  ids: string[];
  partial: boolean;
  pageInfo: z.infer<typeof pageInfo>;
}

async function countHistory(
  loadPage: (cursor: string | null) => Promise<HistoryPage>,
): Promise<HistoryCount> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let partial = false;
  for (let index = 0; index < 10; index++) {
    let page: HistoryPage;
    try {
      page = await loadPage(cursor);
    } catch {
      return index === 0 ? { status: "unavailable" } : { status: "partial", count: ids.size };
    }
    for (const id of page.ids) ids.add(id);
    partial ||= page.partial;
    if (!page.pageInfo.hasNextPage)
      return { status: partial ? "partial" : "complete", count: ids.size };
    cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  return { status: "partial", count: ids.size };
}

async function readHistory(options: ReadFactoryOptions, repository: string, signal: AbortSignal) {
  const readPage = createReader(options, signal);
  const since = options.since.toISOString();
  const until = options.now.toISOString();
  const inWindow = (at: string) =>
    Date.parse(at) >= options.since.getTime() && Date.parse(at) <= options.now.getTime();

  const [owner, name] = repository.split("/");
  const search = `repo:${repository} is:pr is:merged merged:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  const [qualifiedMerges, issueClosures, firstAdmissions] = await Promise.all([
    countHistory(async (cursor) => {
      const { search: page } = mergePage.parse(await readPage(mergesQuery, { search }, cursor));
      const ids: string[] = [];
      let partial = false;
      for (const pr of page.nodes) {
        if (!pr.mergedAt || !inWindow(pr.mergedAt)) continue;
        const issueNumber = factoryBranchIssue(pr, repository);
        if (issueNumber === null) continue;
        const linked = pr.closingIssuesReferences.nodes.some(
          (issue) =>
            issue.number === issueNumber &&
            issue.repository.nameWithOwner.toLowerCase() === repository.toLowerCase(),
        );
        const marked =
          pr.headRefName === `factory/issue-${issueNumber}` &&
          new Set(markerInstallations(pr.body, pr.headRefName)).size === 1;
        if (linked || marked) ids.push(pr.id);
        else partial ||= pr.closingIssuesReferences.pageInfo.hasNextPage;
      }
      return { ids, partial, pageInfo: page.pageInfo };
    }),
    countHistory(async (cursor) => {
      const page = issuePage.parse(
        await readPage(closuresQuery, { owner: owner!, name: name!, since }, cursor),
      );
      const ids: string[] = [];
      let partial = false;
      for (const issue of page.repository.issues.nodes) {
        partial ||= issue.timelineItems.pageInfo.hasNextPage;
        const closedInWindow = issue.timelineItems.nodes.filter((event) =>
          inWindow(event.createdAt),
        );
        // The Foreman can close an issue manually after merging. A historical cross-reference
        // from that issue's Factory branch still identifies the linked work.
        const verified = closedInWindow.some(
          (event) =>
            isLinkedMerge(event.closer, repository, issue.number, event.createdAt) ||
            issue.references.nodes.some(
              ({ createdAt, source }) =>
                Date.parse(createdAt) <= Date.parse(event.createdAt) &&
                isLinkedMerge(source, repository, issue.number, event.createdAt),
            ),
        );
        if (verified) ids.push(String(issue.number));
        else if (closedInWindow.length) partial ||= issue.references.pageInfo.hasPreviousPage;
      }
      return { ids, partial, pageInfo: page.repository.issues.pageInfo };
    }),
    countHistory(async (cursor) => {
      const page = admissionsPage.parse(
        await readPage(admissionsQuery, { owner: owner!, name: name!, since }, cursor),
      );
      const ids: string[] = [];
      let partial = false;
      for (const issue of page.repository.issues.nodes) {
        if (issue.timelineItems.pageInfo.hasNextPage) {
          partial = true;
          continue;
        }
        const admissions = issue.timelineItems.nodes.filter((event) =>
          factoryLabels.has(event.label.name),
        );
        const first = admissions
          .map((event) => Date.parse(event.createdAt))
          .sort((a, b) => a - b)[0];
        if (
          first !== undefined &&
          first >= options.since.getTime() &&
          first <= options.now.getTime()
        ) {
          ids.push(String(issue.number));
        }
      }
      return { ids, partial, pageInfo: page.repository.issues.pageInfo };
    }),
  ]);
  return { qualifiedMerges, issueClosures, firstAdmissions };
}

/** Reads retained queue observations and GitHub history without refreshing Factory or writing its state. */
export async function readDashboardFactory(
  options: ReadFactoryOptions,
): Promise<DashboardFactoryMeasurement> {
  let registry: Awaited<ReturnType<ProjectFactoryStateStore["read"]>>;
  try {
    registry = await new ProjectFactoryStateStore(
      projectFactoryStatePath(options.paseoHome),
    ).read();
  } catch {
    return { status: "unavailable", reason: "registry-unreadable" };
  }
  const active = new Set(
    options.projects
      .filter((project) => project.archivedAt === null)
      .map((project) => project.projectId),
  );
  const enrolled: FactoryProject[] = [];
  for (const [projectId, state] of Object.entries(registry.projects)) {
    if (!state.enabled || !active.has(projectId)) continue;
    const repository = repositorySchema.safeParse(state.repository);
    if (!repository.success) return { status: "unavailable", reason: "invalid-repository" };
    enrolled.push({
      projectId,
      repository: repository.data,
      paused: state.paused || Boolean(state.drain),
    });
  }

  const deadline = AbortSignal.timeout(25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const histories = new Map<string, ReturnType<typeof readHistory>>();
  const projects: FactoryMeasurement[] = [];
  for (const project of enrolled) {
    const key = project.repository.toLowerCase();
    let history = histories.get(key);
    if (!history) {
      history = readHistory(options, project.repository, signal);
      histories.set(key, history);
    }
    const queue = await readStages(options, project);
    const [oldestOpenIssue, counts] = await Promise.all([
      readOldestOpenIssue(options, project.repository, queue, signal),
      history,
    ]);
    projects.push({ ...project, stages: queue.stages, oldestOpenIssue, ...counts });
  }
  return { status: "available", projects };
}
