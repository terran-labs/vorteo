import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createAgentActions } from "./agent-actions.js";
import { ORDINARY_SETTINGS } from "./queued-agent-action-definitions.js";
import { OWNER_ONLY_OPERATIONS } from "./delegated-admission.js";
import { OWNER_ROUTE_FRONT_DOORS } from "./front-door.js";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

// Reviewed immediate doors and the only effects each may call. A new immediate door is a
// reviewed change here, never just a route entry: an action that restarts, installs or changes
// configuration needs a queue with a cancellation window instead.
const PINNED_IMMEDIATE: Readonly<Record<string, readonly string[]>> = {
  "/api/installation/owner/snapshots": ["requireReleaseRuntime", "takeSnapshot"],
  "/api/installation/owner/helpers/verify-installed": ["verifyHelperRecovery"],
  "/api/installation/owner/dev-repair/prepare": ["requestDevRepair", "prepareBatches"],
};
// Each queued installation change and the owner operation both its definition and the owner's
// route call, so a definition can never do something its owner route does not.
const PINNED_QUEUED = {
  "installation-name": [
    "/api/installation/owner/name",
    "installationName.write(",
    "ports.name.write(",
  ],
  "live-dev": [
    "/api/installation/owner/live-dev/change",
    "liveDev.change(",
    "ports.liveDev.change(",
  ],
  "installation-type": [
    "/api/installation/owner/installation-type/change",
    "changeInstallationType(",
    "ports.installationType.change(",
  ],
  "installation-settings": [
    "/api/installation/owner/settings",
    "settings.update(",
    "ports.settings.update(",
  ],
  "custom-domain": [
    "/api/installation/owner/custom-domain/change",
    "customDomain.change(",
    "ports.customDomain.change(",
  ],
} as const;

// Parsing, replies, error logging and the receipt wrapper: calls that change nothing.
const PLUMBING = new Set([
  "async",
  "then",
  "catch",
  "status",
  "json",
  "error",
  "run",
  "parse",
  "strictObject",
  "string",
  "uuid",
  "min",
  "max",
  "optional",
]);

/** Calls in a handler that are neither plumbing nor the door's reviewed effects. */
function unreviewedCalls(handler: string, effects: readonly string[]): string[] {
  const calls = [...handler.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]!);
  return [...new Set(calls)].filter((call) => !PLUMBING.has(call) && !effects.includes(call));
}

/** The source of the handler registered for a route, up to the next registration. */
function handlerOf(server: string, route: string): string {
  const start = server.indexOf(`"${route}"`);
  expect(start, route).toBeGreaterThan(0);
  const end = server.indexOf("app.", start);
  return server.slice(start, end === -1 ? undefined : end);
}

/** The Host-agent route an immediate command calls, found through the client's resource. */
function agentHandlerOf(server: string, command: string): string {
  const client = read("../../../../../scripts/installation-agent.mjs");
  const block = client.slice(client.indexOf(`case "${command}"`));
  const resource = /resource = "([^"]+)"/.exec(block)?.[1];
  expect(resource, command).toBeDefined();
  return handlerOf(server, resource!);
}

// Existing owner operations still waiting for an agent door. Shrink this list as doors ship;
// never grow it. A new operation ships with its agent door instead (docs/task-delivery.md).
const PINNED_GAPS = [
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
    if ("immediate" in door) {
      expect(client, `${route} needs agent command ${door.immediate}`).toContain(
        `case "${door.immediate}"`,
      );
      // No window protects an immediate action: both handlers call only its reviewed effects.
      const effects = PINNED_IMMEDIATE[route];
      expect(effects, `${route} is not a reviewed immediate door`).toBeDefined();
      for (const handler of [handlerOf(server, route), agentHandlerOf(server, door.immediate)]) {
        expect(unreviewedCalls(handler, effects!), route).toEqual([]);
        for (const effect of effects!) expect(handler, route).toContain(`${effect}(`);
      }
    }
    if ("agent" in door)
      expect(client, `${route} needs agent command ${door.agent}`).toContain(
        `case "${door.agent}"`,
      );
    // An exclusion is real only when the grant actually refuses it.
    if ("excluded" in door) expect(OWNER_ONLY_OPERATIONS, route).toContain(door.excluded);
  }
  const immediate = entries.filter(([, door]) => "immediate" in door).map(([route]) => route);
  expect(immediate.sort()).toEqual(Object.keys(PINNED_IMMEDIATE).sort());
  // Handlers that change configuration fail the immediate check, however they spell it.
  const reviewed = Object.values(PINNED_IMMEDIATE).flat();
  for (const [route, write] of [
    ["/api/installation/owner/settings", "update"],
    ["/api/installation/owner/installation-type/change", "changeInstallationType"],
    ["/api/installation/owner/name", "write"],
    ["/api/installation/owner/live-dev/change", "change"],
  ] as const)
    expect(unreviewedCalls(handlerOf(server, route), reviewed), route).toContain(write);
  // Every queued definition is pinned to the operation its owner route performs.
  const definitions = read("./queued-agent-action-definitions.ts");
  const named = [...definitions.matchAll(/name: "([a-z-]+)"/g)].map((match) => match[1]!);
  expect(named.sort()).toEqual(Object.keys(PINNED_QUEUED).sort());
  for (const [action, [route, ownerCall, definitionCall]] of Object.entries(PINNED_QUEUED)) {
    expect(OWNER_ROUTE_FRONT_DOORS[route], action).toEqual({
      agent: "request-installation-change",
    });
    expect(handlerOf(server, route).replace(/\s+/g, ""), action).toContain(ownerCall);
    const block = definitions.slice(definitions.indexOf(`name: "${action}"`));
    const end = block.indexOf("\n    {", 1);
    expect(end === -1 ? block : block.slice(0, end), action).toContain(definitionCall);
  }
  // Ordinary settings exclude every guardrail and credential field.
  expect(ORDINARY_SETTINGS).toEqual([
    "autoArchiveAfterMerge",
    "metadataGeneration",
    "terminalProfiles",
  ]);
  // A new route cannot join any list by adding a sentence: all are pinned here.
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

test("an immediate agent action needs the full grant and leaves a receipt either way", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agent-actions-"));
  try {
    let grant: { policyActivatedAt: string; authoritySha256: string } | null = null;
    const actions = createAgentActions({ stateDir, grant: () => grant });
    const perform = async () => ({ result: 1, detail: "Took safety snapshot." });
    // Without the grant nothing runs and nothing is recorded: the owner acts instead.
    await expect(actions.run("request-snapshot", "Builds", perform)).rejects.toThrow("delegation");
    expect(actions.list()).toEqual([]);
    grant = { policyActivatedAt: "2026-11-01T00:00:00.000Z", authoritySha256: "a".repeat(64) };
    // The receipt is durable before the action has any effect.
    await actions.run("request-snapshot", "Builds", async () => {
      expect(actions.list()[0]?.outcome).toBe("started");
      return perform();
    });
    await expect(
      actions.run("request-snapshot", "Builds", async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(actions.list().map(({ outcome, requester }) => [outcome, requester])).toEqual([
      ["failed", "Builds"],
      ["succeeded", "Builds"],
    ]);
    // A coordinator that stopped mid-action leaves it started; the next one reports it
    // interrupted and never replays it.
    let release!: () => void;
    const hanging = actions.run(
      "request-snapshot",
      "Builds",
      () => new Promise<never>((_resolve, reject) => (release = () => reject(new Error("gone")))),
    );
    // Retention never evicts the running action's receipt, however many finish meanwhile.
    for (let index = 0; index < 60; index += 1)
      await actions.run("request-snapshot", "Builds", perform);
    expect(actions.list().filter((receipt) => receipt.outcome === "started")).toHaveLength(1);
    expect(actions.list()).toHaveLength(51);
    const restarted = createAgentActions({ stateDir, grant: () => grant });
    const interrupted = restarted.list().find((receipt) => receipt.outcome === "interrupted");
    expect(interrupted).toBeDefined();
    release();
    await expect(hanging).rejects.toThrow("gone");
    // Its outcome, recorded after 60 newer receipts, is still in the history.
    expect(actions.list()[0]).toMatchObject({ id: interrupted!.id, outcome: "failed" });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
