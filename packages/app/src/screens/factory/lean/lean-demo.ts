import type { FactoryReleaseEvent } from "../../../../../../plugins/factory/shared/lean";
import type { LeanStatus, LeanView } from "./lean-factory-source";

/**
 * Representative lean Factory data: two machines, a Builder and a Reviewer at work, a Delivery
 * runner holding the lock, production at 1.4.0, two betas after it and two releases before it.
 * Used by tests and demos; no real repository, account or credential.
 */

const M2 = "srv_m2/mira";
const STUDIO = "srv_studio/mira";

export function demoRelease(
  overrides: Partial<FactoryReleaseEvent> & Pick<FactoryReleaseEvent, "id" | "version" | "at">,
): FactoryReleaseEvent {
  return {
    kind: "beta",
    channel: "beta",
    commit: "0".repeat(40),
    artifact: null,
    by: { runner: null, ownerAction: null },
    contents: [],
    gates: [],
    ...overrides,
  };
}

export const demoProduction = demoRelease({
  id: "rel-140",
  kind: "promote",
  channel: "stable",
  version: "1.4.0",
  at: "2026-11-25T18:00:00Z",
});

export function demoLeanStatus(overrides: Partial<LeanStatus> = {}): LeanStatus {
  return {
    projectId: "mira",
    mode: "lean",
    installation: M2,
    revision: 7,
    lanes: [],
    issues: [
      {
        issue: 41,
        title: "Fix room reset on reconnect",
        stage: "building",
        installation: STUDIO,
        runner: { agentId: "agent-builder-41", role: "lead", serverId: "srv_studio" },
        // The Builder runs on the Studio while its Reviewer runs on the primary.
        runners: [
          {
            agentId: "agent-builder-41",
            role: "lead",
            serverId: "srv_studio",
            installation: STUDIO,
            friendlyName: "Studio",
          },
          {
            agentId: "agent-reviewer-41",
            role: "reviewer",
            serverId: null,
            installation: M2,
            friendlyName: "M2",
          },
        ],
        pr: null,
        lastActivityAt: null,
        deadline: null,
        waitingOn: null,
      },
      {
        issue: 42,
        title: "Faster shader warmup",
        stage: "review",
        installation: M2,
        runner: { agentId: "agent-reviewer-42", role: "reviewer", serverId: null },
        pr: { number: 90, headSha: "1".repeat(40), checks: "passing" },
        lastActivityAt: null,
        deadline: null,
        waitingOn: null,
      },
      {
        issue: 43,
        title: "Queued polish",
        stage: "queued",
        installation: null,
        runner: null,
        pr: null,
        lastActivityAt: null,
        deadline: null,
        waitingOn: null,
      },
      {
        issue: 44,
        title: "Plan check",
        stage: "planning",
        installation: M2,
        runner: { agentId: "agent-lead-op-44", role: "foreman-op", serverId: null },
        pr: null,
        lastActivityAt: null,
        deadline: null,
        waitingOn: null,
      },
    ],
    escalations: [
      {
        id: "esc-1",
        question: "Should reconnect keep the old room?",
        openedAt: "2026-11-27T19:00:00Z",
        blocksIssues: [41],
      },
    ],
    alerts: [],
    ...overrides,
  };
}

export function demoLeanView(overrides: Partial<LeanView> = {}): LeanView {
  return {
    production: demoProduction,
    betas: [
      demoRelease({ id: "rel-141b1", version: "1.4.1-beta.1", at: "2026-11-26T18:00:00Z" }),
      demoRelease({ id: "rel-141b2", version: "1.4.1-beta.2", at: "2026-11-27T18:00:00Z" }),
    ],
    earlier: [
      demoRelease({
        id: "rel-130",
        kind: "promote",
        channel: "stable",
        version: "1.3.0",
        at: "2026-11-20T18:00:00Z",
      }),
      demoRelease({
        id: "rel-131f",
        kind: "failed",
        version: "1.3.1-beta.1",
        at: "2026-11-22T18:00:00Z",
      }),
    ],
    inFlight: [],
    machines: [
      {
        installation: M2,
        factory: "on",
        mode: "lean",
        daemonVersion: "2026.11.27",
        leanProtocol: 1,
        heavyQueueLimit: 3,
        runnersMax: 4,
        runnersOpen: 2,
        lastSeenAt: "2026-11-27T19:00:00Z",
        freshness: "fresh",
        friendlyName: "M2",
        lanes: ["intake", "merge", "delivery", "releaseBuild", "mechanic"],
        serverId: null,
      },
      {
        installation: STUDIO,
        factory: "on",
        mode: "lean",
        daemonVersion: "2026.11.27",
        leanProtocol: 1,
        heavyQueueLimit: 3,
        runnersMax: 4,
        runnersOpen: 1,
        lastSeenAt: "2026-11-27T19:00:00Z",
        freshness: "fresh",
        friendlyName: null,
        lanes: [],
        serverId: "srv_studio",
      },
    ],
    previews: [],
    health: {
      alerts: [],
      deliveryLock: {
        holder: { kind: "runner", agentId: "agent-delivery-1", installationId: M2 },
        batch: "Batch 12",
        expiresAt: "2026-11-27T20:00:00Z",
      },
    },
    recipe: { valid: true, error: null },
    readiness: { ownerActions: true, deliveryActions: true },
    pendingBeta: null,
    delivery: null,
    deliveryQueue: [],
    ...overrides,
  };
}

/** The demo page's states: everything ready, actions not ready, and a new project with no Lead. */
export type DemoState = "ready" | "not-ready" | "new-project";

function demoConfig(provider: string): string {
  return `{
  "schema": "vorteo-factory",
  "version": 1,
  "mode": "lean",
  "order": ["srv_m2/mira"],
  "builder": { "provider": "${provider}" },
  "lease": { "ttlMinutes": 120 }
}
`;
}

/** Provider entries as the installation's snapshot reports them; Gemini is installed but off. */
export const DEMO_PROVIDER_ENTRIES = [
  { provider: "codex", enabled: true },
  { provider: "claude", enabled: true },
  { provider: "antigravity", enabled: true },
  { provider: "gemini", enabled: false },
];

const pr = (number: number, issue: number, title: string) => ({ pr: number, issue, title });

/** Mira-like releases: production, three newer betas, two earlier releases and a failed beta. */
function demoReleases(): Pick<LeanView, "production" | "betas" | "earlier"> {
  return {
    production: demoRelease({
      id: "rel-140",
      kind: "promote",
      channel: "stable",
      version: "1.4.0",
      at: "2026-11-25T18:00:00Z",
      contents: [pr(80, 30, "Spatial audio for rooms"), pr(82, 33, "Faster join")],
    }),
    betas: [
      demoRelease({
        id: "rel-141b1",
        version: "1.4.1-beta.1",
        at: "2026-11-26T02:00:00Z",
        contents: [pr(84, 35, "Fix echo on rejoin")],
      }),
      demoRelease({
        id: "rel-141b2",
        version: "1.4.1-beta.2",
        at: "2026-11-26T22:00:00Z",
        contents: [pr(86, 37, "Room list loads offline"), pr(87, 38, "Clearer mute state")],
      }),
      demoRelease({
        id: "rel-141b3",
        version: "1.4.1-beta.3",
        at: "2026-11-27T17:30:00Z",
        contents: [pr(88, 39, "Stop audio pop on join")],
      }),
    ],
    earlier: [
      demoRelease({
        id: "rel-131b2f",
        kind: "failed",
        version: "1.3.1-beta.2",
        at: "2026-11-22T18:00:00Z",
      }),
      demoRelease({
        id: "rel-131",
        kind: "promote",
        channel: "stable",
        version: "1.3.1",
        at: "2026-11-23T18:00:00Z",
      }),
      demoRelease({
        id: "rel-130",
        kind: "promote",
        channel: "stable",
        version: "1.3.0",
        at: "2026-11-18T18:00:00Z",
      }),
    ],
  };
}

/**
 * Delivery in the executor's words. Ready and Not ready: a promote whose deploy outcome is
 * unknown, with a rollback queued behind it. New project: a promote waiting for approval, with a
 * rollback queued behind the delivery in progress.
 */
function demoDelivery(state: DemoState) {
  if (state === "new-project") {
    return {
      delivery: {
        state: "awaiting-approval",
        jobId: "run-12",
        kind: "promote",
        version: "1.4.1-beta.3",
        approvalUrl: "https://github.com/",
        waitingOn: null,
      },
      deliveryQueue: [
        {
          jobId: "run-12",
          kind: "promote",
          state: "awaiting-approval",
          version: "1.4.1-beta.3",
          waitingOn: null,
        },
        {
          jobId: "run-13",
          kind: "rollback",
          state: "pending",
          version: "1.3.1",
          waitingOn:
            "Waits for the promote already in progress to finish; it never runs alongside it.",
        },
      ],
    };
  }
  return {
    delivery: {
      state: "failed",
      jobId: "run-12",
      kind: "promote",
      version: "1.4.1-beta.3",
      approvalUrl: null,
      waitingOn: null,
      failureKind: "unknown",
      failureReason:
        "The daemon restarted during the deploy step. Check the target, then choose verify, rerun or abandon.",
    },
    deliveryQueue: [
      {
        jobId: "run-12",
        kind: "promote",
        state: "failed",
        version: "1.4.1-beta.3",
        waitingOn: null,
      },
      {
        jobId: "run-13",
        kind: "rollback",
        state: "pending",
        version: "1.3.1",
        waitingOn:
          "Waits for you to settle the promote whose outcome is unknown; it never runs alongside it.",
      },
    ],
  };
}

/** The view a daemon would send for a demo state, in wire shape. */
export function demoWireView(state: DemoState, held = false, shipsAt?: string) {
  const ready = state === "ready";
  const base = demoLeanView(demoReleases());
  const [primary, studio] = base.machines;
  return {
    ...base,
    machines: [primary!, Object.assign({}, studio!, { friendlyName: "Studio" })],
    previews: [
      {
        workspaceId: "wks-demo",
        title: "Room reset fix",
        state: "ready",
        url: null,
        updatedAt: "2026-11-27T19:30:00Z",
      },
    ],
    health: {
      alerts: [],
      deliveryLock: {
        holder: M2,
        holderInfo: { kind: "runner", agentId: "agent-delivery-1", installationId: M2 },
        batch: "Batch 12",
        expiresAt: "2026-11-27T20:00:00Z",
      },
    },
    pendingBeta: {
      eventId: "rel-142b1",
      // A new project's first beta has no version until the release tool runs.
      version: state === "new-project" ? null : "1.4.2-beta.1",
      shipsAt: shipsAt ?? new Date(Date.now() + 8 * 60_000).toISOString(),
      held,
    },
    ...demoDelivery(state),
    readiness: { ownerActions: ready, deliveryActions: ready },
  };
}

/**
 * A stand-in for the Factory plugin's `invoke`, serving demo data in wire shape. Hold and Let it
 * ship change the demo's own state; every other write is refused or only queued, so nothing
 * reaches a real Factory, repository or release.
 */
export function createDemoLeanInvoke(
  state: DemoState = "ready",
): (method: string, input: unknown) => Promise<unknown> {
  let held = false;
  const shipsAt = new Date(Date.now() + 8 * 60_000).toISOString();
  return async (method) => {
    switch (method) {
      case "factory.lean.status":
        return demoLeanStatus();
      case "factory.lean.view":
        return demoWireView(state, held, shipsAt);
      case "factory.lean.activity.list":
        return {
          entries: [
            {
              id: "a1",
              at: "2026-11-27T19:40:00Z",
              class: "mechanical",
              kind: "merged",
              issue: 39,
              text: "Merged #88: Stop audio pop on join",
              url: null,
            },
            {
              id: "a2",
              at: "2026-11-27T19:20:00Z",
              class: "judgment",
              kind: "sent-back",
              issue: 41,
              text: "Sent #41 back: criterion 2 not met",
              url: null,
            },
            {
              id: "a3",
              at: "2026-11-27T17:30:00Z",
              class: "mechanical",
              kind: "beta",
              issue: null,
              text: "Beta 1.4.1-beta.3 shipped",
              url: null,
            },
          ],
          nextBefore: null,
        };
      case "factory.lean.releases.hold":
        held = true;
        return { held };
      case "factory.lean.releases.release":
        held = false;
        return { held };
      case "factory.lean.releases.promote":
      case "factory.lean.releases.rollback":
        return { queued: true, jobId: "demo-job" };
      case "factory.lean.config.read":
        return {
          // The new project's file names a provider this installation has not enabled.
          file: demoConfig(state === "new-project" ? "gemini" : "codex"),
          commit: "a".repeat(40),
          installations: [
            { id: M2, friendlyName: "M2", seenAs: ["this"] },
            { id: STUDIO, friendlyName: "Studio", seenAs: ["presence"] },
          ],
        };
      case "factory.lean.delivery.resolve":
        return { resolved: true };
      case "factory.lean.config.propose":
        return { refused: "Demo only. No pull request was opened." };
      default:
        throw new Error(`The demo does not serve ${method}`);
    }
  };
}
