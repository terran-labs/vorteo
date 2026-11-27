import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDashboardFactory, type DashboardFactoryGraphQL } from "./dashboard-factory.js";

const repository = "example/first";
const enrolled = "project-first";
const missing = "project-missing";
const staleAt = "2026-11-25T11:00:00Z";
const since = new Date("2026-11-25T12:00:00Z");
const now = new Date("2026-11-25T13:00:00Z");
const pageInfo = { hasNextPage: false, endCursor: null };

function project(name: string, enabled = true) {
  return {
    repository: name,
    enabled,
    paused: false,
    workers: { workerProfileId: null, reviewerProfileId: null },
    roles: {},
  };
}

describe("readDashboardFactory", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dashboard-factory-"));
    await mkdir(path.join(home, "factory", "queues"), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeRegistry(projects: Record<string, ReturnType<typeof project>>) {
    await writeFile(
      path.join(home, "factory", "projects.json"),
      JSON.stringify({ schemaVersion: 1, projects }),
    );
  }

  function read(graphql: DashboardFactoryGraphQL) {
    return readDashboardFactory({
      paseoHome: home,
      now,
      since,
      queueMaxAgeMs: 60_000,
      graphql,
      projects: [
        { projectId: enrolled, archivedAt: null },
        { projectId: missing, archivedAt: null },
        { projectId: "archived", archivedAt: staleAt },
        { projectId: "disabled", archivedAt: null },
      ],
    });
  }

  it("preserves stale, partial and absent queue observations for enabled active projects", async () => {
    await writeRegistry({
      [enrolled]: project(repository),
      [missing]: project("example/second"),
      archived: project("example/archived"),
      disabled: project("example/disabled", false),
    });
    await writeFile(
      path.join(home, "factory", "queues", enrolled + ".json"),
      JSON.stringify({
        repository,
        queue: {
          fetchedAt: staleAt,
          error: null,
          degraded: "Dev unavailable",
          issues: [
            {
              number: 4,
              title: "Plan",
              url: "",
              label: "running",
              stage: "planning",
              pr: null,
              agents: [],
            },
          ],
        },
      }),
    );
    const unavailable = () => Promise.reject(new Error("Offline"));
    const result = await read(unavailable);
    expect(result).toMatchObject({
      status: "available",
      projects: [
        {
          projectId: enrolled,
          oldestOpenIssue: { status: "unavailable" },
          stages: {
            status: "observed",
            fetchedAt: staleAt,
            stale: true,
            partial: true,
            counts: { planning: 1 },
          },
          qualifiedMerges: { status: "unavailable" },
          issueClosures: { status: "unavailable" },
        },
        { projectId: missing, stages: { status: "unavailable", reason: "missing" } },
      ],
    });
  });

  it("qualifies merges and counts separately timed issue closure events without treating partial history as complete", async () => {
    await writeRegistry({ [enrolled]: project(repository) });
    const pr = {
      id: "pr-4",
      body: "",
      headRefName: "factory/issue-4",
      isCrossRepository: false,
      repository: { nameWithOwner: repository },
      mergedAt: "2026-11-25T12:10:00Z",
      closingIssuesReferences: {
        pageInfo,
        nodes: [{ number: 4, repository: { nameWithOwner: repository } }],
      },
    };
    const graphql: DashboardFactoryGraphQL = async (query, variables) => {
      if (query.includes("search(type:")) {
        if (variables.cursor) throw new Error("Page unavailable");
        return {
          data: {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "next" },
              nodes: [
                pr,
                { ...pr, id: "fork", isCrossRepository: true },
                { ...pr, id: "wrong-issue", headRefName: "factory/issue-42" },
              ],
            },
          },
        };
      }
      const event = { createdAt: "2026-11-25T12:20:00Z", closer: null };
      function issueWithReference(number: number, referenceAt: string) {
        return {
          number,
          timelineItems: { pageInfo, nodes: [event, event] },
          references: {
            pageInfo: { hasPreviousPage: false },
            nodes: [
              {
                createdAt: referenceAt,
                source: {
                  __typename: "PullRequest",
                  ...pr,
                  headRefName: `factory/issue-${number}`,
                  mergedAt: "2026-11-24T12:10:00Z",
                },
              },
            ],
          },
        };
      }
      return {
        data: {
          repository: {
            issues: {
              pageInfo,
              nodes: [
                issueWithReference(4, event.createdAt),
                issueWithReference(5, "2026-11-25T12:20:01Z"),
              ],
            },
          },
        },
      };
    };
    expect(await read(graphql)).toMatchObject({
      status: "available",
      projects: [
        {
          qualifiedMerges: { status: "partial", count: 1 },
          issueClosures: { status: "complete", count: 1 },
        },
      ],
    });
  });

  it("verifies the oldest open issue across stages and treats incomplete first-admission history as partial", async () => {
    await writeRegistry({ [enrolled]: project(repository) });
    await writeFile(
      path.join(home, "factory", "queues", enrolled + ".json"),
      JSON.stringify({
        repository,
        queue: {
          fetchedAt: now.toISOString(),
          error: null,
          issues: [4, 5].map((number) => ({
            number,
            title: "Queued",
            url: "",
            label: number === 4 ? "blocked" : "ready",
            stage: number === 4 ? "blocked" : "queued",
            pr: null,
            agents: [],
          })),
        },
      }),
    );
    const label = { name: "factory:ready" };
    function admission(createdAt: string) {
      return { label, createdAt };
    }
    const newlyAdmitted = admission("2026-11-25T12:30:00Z");
    const priorAdmission = admission("2026-11-24T12:30:00Z");
    function history(number: number, hasNextPage: boolean, nodes: ReturnType<typeof admission>[]) {
      return { number, timelineItems: { pageInfo: { hasNextPage }, nodes } };
    }
    const graphql: DashboardFactoryGraphQL = async (query) => {
      if (query.includes("LABELED_EVENT")) {
        const nodes = [
          history(4, false, [newlyAdmitted]),
          history(5, false, [priorAdmission, newlyAdmitted]),
          history(6, true, [newlyAdmitted]),
        ];
        return { data: { repository: { issues: { pageInfo, nodes } } } };
      }
      if (!query.includes("issue4:")) throw new Error("Source unavailable");
      return {
        data: {
          repository: {
            issue4: {
              number: 4,
              state: "OPEN",
              createdAt: "2026-11-20T12:30:00Z",
              labels: { nodes: [label] },
            },
            issue5: {
              number: 5,
              state: "OPEN",
              createdAt: "2026-11-24T12:30:00Z",
              labels: { nodes: [label] },
            },
          },
        },
      };
    };
    expect(await read(graphql)).toMatchObject({
      status: "available",
      projects: [
        {
          firstAdmissions: { status: "partial", count: 1 },
          oldestOpenIssue: {
            status: "complete",
            oldestCreatedAt: "2026-11-20T12:30:00.000Z",
            ageDays: 5,
          },
        },
      ],
    });
  });
});
