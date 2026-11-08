import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { OWNER_ONLY_OPERATIONS } from "./delegated-admission.js";
import { OWNER_ROUTE_FRONT_DOORS } from "./front-door.js";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

// Existing owner operations still waiting for an agent door. Shrink this list as doors ship;
// never grow it. A new operation ships with its agent door instead (docs/task-delivery.md).
const PINNED_GAPS = [
  "/api/installation/owner/custom-domain/change",
  "/api/installation/owner/dev-repair/prepare",
  "/api/installation/owner/helpers/verify-installed",
  "/api/installation/owner/installation-type/change",
  "/api/installation/owner/live-dev/change",
  "/api/installation/owner/name",
  "/api/installation/owner/settings",
  "/api/installation/owner/snapshots",
  "/api/installation/owner/source-upgrades",
  "/api/installation/owner/source-upgrades/:id/decision",
];

// Routes the grant never approves, each on OWNER_ONLY_OPERATIONS.
const PINNED_EXCLUSIONS = [
  "/api/installation/owner/connections",
  "/api/installation/owner/instruction-requests/decision",
  "/api/installation/owner/profiles",
  "/api/installation/owner/profiles/resolve",
  "/api/installation/owner/profiles/synchronize",
  "/api/installation/owner/settings/plugins/resolve",
  "/api/installation/owner/settings/skills/package",
  "/api/installation/owner/settings/skills/prepare",
  "/api/installation/owner/snapshots/restore",
  "/api/installation/owner/source-upgrades/rollback",
];

// Routes that never get an agent door: owner session, grant management, read-only views and
// release upgrades, which the update policy approves.
const PINNED_EXEMPTIONS = [
  "/api/installation/owner/daemon-automation/change",
  "/api/installation/owner/lock",
  "/api/installation/owner/maintenance-delegation/change",
  "/api/installation/owner/maintenance-permissions/change",
  "/api/installation/owner/profiles/read",
  "/api/installation/owner/restarts/impact",
  "/api/installation/owner/session",
  "/api/installation/owner/settings/read",
  "/api/installation/owner/settings/skills/preview",
  "/api/installation/owner/unlock",
  "/api/installation/owner/update-check",
  "/api/installation/owner/update-policy",
  "/api/installation/owner/upgrades",
  "/api/installation/owner/upgrades/:id/decision",
];

test("every owner route that changes something has an agent front door, an exclusion or a pinned entry", () => {
  const server = read("./server.ts");
  const client = read("../../../../../scripts/installation-agent.mjs");
  // Every owner route registered in server.ts, whatever its HTTP method.
  const routes = new Set(
    [
      ...server.matchAll(
        /app\.(?:post|put|patch|delete)\(\s*"(\/api\/installation\/owner\/[^"]+)"/g,
      ),
    ]
      .map((match) => match[1]!)
      .filter((route) => !route.endsWith("/query")),
  );
  expect(routes.size).toBeGreaterThan(20);
  const unlisted = [...routes].filter((route) => !(route in OWNER_ROUTE_FRONT_DOORS));
  expect(unlisted, "add these routes to OWNER_ROUTE_FRONT_DOORS").toEqual([]);
  const stale = Object.keys(OWNER_ROUTE_FRONT_DOORS).filter((route) => !routes.has(route));
  expect(stale, "remove routes server.ts no longer registers").toEqual([]);

  const entries = Object.entries(OWNER_ROUTE_FRONT_DOORS);
  for (const [route, door] of entries) {
    if ("agent" in door)
      expect(client, `${route} needs agent command ${door.agent}`).toContain(
        `case "${door.agent}"`,
      );
    // An exclusion is real only when the grant actually refuses it.
    if ("excluded" in door) expect(OWNER_ONLY_OPERATIONS, route).toContain(door.excluded);
  }
  // A new route cannot join any list by adding a sentence: all three are pinned here.
  const excluded = entries.filter(([, door]) => "excluded" in door).map(([route]) => route);
  expect(excluded.sort()).toEqual(PINNED_EXCLUSIONS);
  const gaps = entries.filter(([, door]) => "gap" in door).map(([route]) => route);
  expect(gaps.sort()).toEqual(PINNED_GAPS);
  const exempt = entries.filter(([, door]) => "exempt" in door).map(([route]) => route);
  expect(exempt.sort()).toEqual(PINNED_EXEMPTIONS);
  // Agents can never grant themselves the authority that approves their own requests.
  expect(OWNER_ROUTE_FRONT_DOORS["/api/installation/owner/maintenance-delegation/change"]).toEqual(
    expect.objectContaining({ exempt: "grant" }),
  );
  // The exclusions are named on purpose: guardrail edits, install rollback and credentials.
  expect(OWNER_ONLY_OPERATIONS).toEqual([
    "instruction-requests",
    "agent-guardrails",
    "snapshot-restore",
    "source-upgrade-rollback",
    "account-credentials",
  ]);
});
