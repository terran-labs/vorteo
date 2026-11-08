import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { OWNER_ONLY_OPERATIONS } from "./delegated-admission.js";
import { OWNER_ROUTE_FRONT_DOORS } from "./front-door.js";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("every owner route that changes something has an agent front door or a stated exemption", () => {
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
  for (const [route, door] of Object.entries(OWNER_ROUTE_FRONT_DOORS)) {
    if ("exempt" in door) expect(door.exempt.length, route).toBeGreaterThan(20);
    else
      expect(client, `${route} needs agent command ${door.agent}`).toContain(
        `case "${door.agent}"`,
      );
  }
  // Agents can never grant themselves the authority that approves their own requests.
  expect(
    OWNER_ROUTE_FRONT_DOORS["/api/installation/owner/maintenance-delegation/change"],
  ).toHaveProperty("exempt");
  // Excluded operations are named on purpose; each still has an agent request route.
  expect(OWNER_ONLY_OPERATIONS).toEqual(["instruction-requests"]);
});
