import type { PreviewVersion } from "@getpaseo/protocol/previews";
import { expect, test } from "vitest";
import {
  buildPairUrl,
  groupByLineage,
  matchLivePreview,
  scopeVersions,
  sortLineages,
} from "./model";

function version(id: string, overrides: Partial<PreviewVersion> = {}): PreviewVersion {
  return {
    id: `${id}-version-token-0000`,
    lineage: "deck",
    number: 1,
    title: "Deck",
    kind: "web",
    createdAt: "2026-11-10T10:00:00.000Z",
    agentId: "agent-a",
    sizeBytes: 10,
    hasThumbnail: false,
    rating: null,
    approved: false,
    annotations: [],
    ...overrides,
  };
}

test("versions group by lineage with the newest version first", () => {
  const groups = groupByLineage([
    version("a1", { lineage: "deck", number: 1 }),
    version("b1", { lineage: "logo", number: 1 }),
    version("a2", { lineage: "deck", number: 2 }),
  ]);
  expect(groups.map((group) => group.lineage)).toEqual(["deck", "logo"]);
  expect(groups[0].newest.id).toBe("a2-version-token-0000");
  expect(groups[0].versions).toHaveLength(2);
});

test("lineages sort by newest time, or by rating with unrated last and ties by time", () => {
  const groups = groupByLineage([
    version("old", { lineage: "old", rating: 3, createdAt: "2026-11-01T00:00:00.000Z" }),
    version("new", { lineage: "new", rating: null, createdAt: "2026-11-09T00:00:00.000Z" }),
    version("mid", { lineage: "mid", rating: 3, createdAt: "2026-11-05T00:00:00.000Z" }),
    version("top", { lineage: "top", rating: 5, createdAt: "2026-10-01T00:00:00.000Z" }),
  ]);
  expect(sortLineages(groups, "newest").map((g) => g.lineage)).toEqual([
    "new",
    "mid",
    "old",
    "top",
  ]);
  expect(sortLineages(groups, "rating").map((g) => g.lineage)).toEqual([
    "top",
    "mid",
    "old",
    "new",
  ]);
});

test("this thread narrows the workspace's previews to what the thread published", () => {
  const versions = [version("a", { agentId: "agent-a" })];
  expect(scopeVersions(versions, "thread", "agent-b")).toEqual([]);
  expect(scopeVersions(versions, "all", "agent-b")).toHaveLength(versions.length);
});

test("pair URLs carry an encoded next that is only the review page or the live URL", () => {
  const base = "https://host.example:6767";
  const frozen = version("f");
  const frozenUrl = new URL(buildPairUrl(base, "t/k+1", frozen));
  expect(`${frozenUrl.origin}${frozenUrl.pathname}`).toBe(`${base}/api/previews/pair`);
  const frozenParams = new URLSearchParams(frozenUrl.hash.slice(1));
  expect(frozenParams.get("ticket")).toBe("t/k+1");
  expect(frozenParams.get("next")).toBe(`/api/previews/view/${frozen.id}`);
  expect(frozenUrl.hash).not.toContain("/api/previews/view/");

  const live = version("l", { kind: "url", liveUrl: "https://preview.example/a?b=1&c=2" });
  const liveParams = new URLSearchParams(new URL(buildPairUrl(base, "t", live)).hash.slice(1));
  expect(liveParams.get("next")).toBe("https://preview.example/a?b=1&c=2");

  // A non-http liveUrl, or a liveUrl on a frozen kind, never becomes the target.
  for (const unsafe of [
    version("j", { kind: "url", liveUrl: "javascript:alert(1)" }),
    version("w", { kind: "web", liveUrl: "https://elsewhere.example/" }),
  ]) {
    const params = new URLSearchParams(new URL(buildPairUrl(base, "t", unsafe)).hash.slice(1));
    expect(params.get("next")).toBe(`/api/previews/view/${unsafe.id}`);
  }
});

test.each<[string, string, string | null]>([
  ["the exact origin, with a path, matches", "https://p.example.ts.net:32780/app?x=1", "wks_a/web"],
  ["another port is not a match", "https://p.example.ts.net:32781/", null],
  ["the same host on its default port is not a match", "https://p.example.ts.net/", null],
  ["plain http is not a match", "http://p.example.ts.net:32780/", null],
  [
    "a port that is a prefix of the reserved port is not a match",
    "https://p.example.ts.net:3278/",
    null,
  ],
  [
    "a reserved port that is a prefix of the link's port is not a match",
    "https://q.example.ts.net:32781/",
    null,
  ],
  ["a reserved origin that is not https is refused", "http://p.example.ts.net:32791/", null],
  ["an origin two previews claim matches neither", "https://p.example.ts.net:32790/", null],
  ["a link that is not a URL matches nothing", "not a url", null],
])("live link matching: %s", (_name, liveUrl, expected) => {
  // Exact origin equality only; any ambiguity shows no state rather than a wrong one.
  const service = (scriptName: string, origin: string) => ({
    scriptName,
    type: "service" as const,
    preview: { state: "stopped", origin },
  });
  const workspaces = [
    {
      workspaceId: "wks_a",
      scripts: [
        service("web", "https://p.example.ts.net:32780"),
        service("api", "https://p.example.ts.net:32790"),
        // Not something the daemon reserves; matching must refuse it even when equal.
        service("plain", "http://p.example.ts.net:32791"),
      ],
    },
    {
      workspaceId: "wks_b",
      scripts: [
        service("web", "https://p.example.ts.net:32790"),
        service("short", "https://q.example.ts.net:3278"),
      ],
    },
  ];
  const match = matchLivePreview(liveUrl, workspaces);
  expect(match && `${match.workspaceId}/${match.script.scriptName}`).toBe(expected);
});
