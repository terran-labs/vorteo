/**
 * The front door for every owner-authenticated installation route that changes something.
 * Each route is exactly one of:
 * - `agent`: an agent request command in scripts/installation-agent.mjs, which Builds uses and
 *   the full maintenance grant approves unless OWNER_ONLY_OPERATIONS names the operation;
 * - `immediate`: an agent request command for a read-only or non-disruptive action, which runs at
 *   once under the grant and leaves a receipt in Installation controls (agent-actions.ts). The
 *   front-door test refuses it for any handler that restarts, installs or changes configuration;
 * - `excluded`: an operation on OWNER_ONLY_OPERATIONS, so it stays with the owner;
 * - `exempt`: owner session, grant management or a read-only view, which never get an agent door;
 * - `gap`: an existing owner operation still waiting for its agent door. The list is pinned in
 *   the front-door test: Builds tracks each entry, and no new route may join it.
 * A new owner route fails the front-door test until it is listed here. Read-only routes ending in
 * `/query` are exempt without an entry.
 */
export type FrontDoor =
  | { agent: string }
  | { immediate: string }
  | { excluded: string; why: string }
  | { exempt: "session" | "grant" | "read" | "alternate"; why: string }
  | { gap: string };

const GRANT = {
  exempt: "grant",
  why: "Grant management: agents never grant, widen or choose their own authority.",
} as const;
const SESSION = {
  exempt: "session",
  why: "Owner sign-in and session control; agents never hold an owner session.",
} as const;
const READ = { exempt: "read", why: "Read-only owner view; it changes nothing." } as const;
const UPGRADES = {
  exempt: "alternate",
  why: "Release upgrades follow the owner's update policy; Builds installs source through request-restart --update.",
} as const;
const CREDENTIALS = {
  excluded: "account-credentials",
  why: "Accounts and credentials: Factory charters forbid agents to touch them, and the grant never alters them.",
} as const;
const GUARDRAILS = {
  excluded: "agent-guardrails",
  why: "Edits agent instructions, skills or plugins: agents never edit their own guardrails (owner decision 2026-11-07).",
} as const;

export const OWNER_ROUTE_FRONT_DOORS: Readonly<Record<string, FrontDoor>> = {
  // Queues an agent requests and the owner, or the full grant, approves.
  "/api/installation/owner/restarts": { agent: "request-restart" },
  "/api/installation/owner/restarts/:id/decision": { agent: "request-restart" },
  "/api/installation/owner/coordinator-follow": { agent: "request-coordinator-follow" },
  "/api/installation/owner/coordinator-follow/:id/decision": {
    agent: "request-coordinator-follow",
  },
  "/api/installation/owner/coordinator-settings/:id/decision": {
    agent: "request-coordinator-settings",
  },
  "/api/installation/owner/broker-deployments/decision": {
    agent: "request-broker-consumer-deployment",
  },
  "/api/installation/owner/broker-rebinds/decision": { agent: "request-broker-channel-rebind" },
  "/api/installation/owner/monitors/decision": { agent: "request-monitor" },
  "/api/installation/owner/helpers/decision": { agent: "request-helper" },
  "/api/installation/owner/session-host/decision": { agent: "request-session-host" },
  "/api/installation/owner/session-host/request": { agent: "request-session-host" },
  "/api/installation/owner/lab-updates": { agent: "request-lab-update" },
  "/api/installation/owner/lab-updates/cancel": { agent: "request-lab-update" },
  // Read-only verification of installed receipts: immediate, with a receipt.
  "/api/installation/owner/helpers/verify-installed": { immediate: "request-helper-verification" },
  // Preparation restarts nothing; the repaired restart takes the delegated restart queue.
  "/api/installation/owner/dev-repair/prepare": { immediate: "request-dev-repair" },
  // A non-disruptive copy: immediate, with a receipt.
  "/api/installation/owner/snapshots": { immediate: "request-snapshot" },
  // Agents cancel retained requests through management-cancel.
  "/api/installation/owner/maintenance-services/cancel": { agent: "management-cancel" },
  // Every queue drain observes the same uncertain outcome; agents follow it with the status command.
  "/api/installation/owner/broker-deployments/observe": { agent: "broker-deployment-status" },

  // Agents request them; OWNER_ONLY_OPERATIONS keeps their approval with the owner.
  "/api/installation/owner/instruction-requests/decision": {
    excluded: "instruction-requests",
    why: "Agents request it with request-instructions; only the owner approves it (owner decision 2026-11-07).",
  },
  "/api/installation/owner/snapshots/restore": {
    excluded: "snapshot-restore",
    why: "Restoring a pre-install snapshot is the owner's decision under the Builds charter.",
  },
  "/api/installation/owner/connections": CREDENTIALS,
  "/api/installation/owner/profiles": CREDENTIALS,
  "/api/installation/owner/profiles/resolve": CREDENTIALS,
  "/api/installation/owner/profiles/synchronize": CREDENTIALS,
  "/api/installation/owner/source-upgrades/rollback": {
    excluded: "source-upgrade-rollback",
    why: "Rolling back an install is the owner's decision under the Builds charter.",
  },
  "/api/installation/owner/settings/plugins/resolve": GUARDRAILS,
  "/api/installation/owner/settings/skills/package": GUARDRAILS,
  "/api/installation/owner/settings/skills/prepare": GUARDRAILS,

  "/api/installation/owner/maintenance-delegation/change": GRANT,
  "/api/installation/owner/maintenance-permissions/change": GRANT,
  "/api/installation/owner/daemon-automation/change": GRANT,
  "/api/installation/owner/session": SESSION,
  "/api/installation/owner/lock": SESSION,
  "/api/installation/owner/unlock": SESSION,
  "/api/installation/owner/restarts/impact": READ,
  "/api/installation/owner/profiles/read": READ,
  "/api/installation/owner/settings/read": READ,
  "/api/installation/owner/settings/skills/preview": READ,
  "/api/installation/owner/upgrades": UPGRADES,
  "/api/installation/owner/upgrades/:id/decision": UPGRADES,
  "/api/installation/owner/update-policy": UPGRADES,
  "/api/installation/owner/update-check": UPGRADES,

  // Queued installation changes (queued-agent-action-definitions.ts): pending and cancellable,
  // approved by the owner or by the full grant after its window. The test pins each action to
  // the owner operation it calls. Ordinary settings only; the rest of the body is guardrails.
  "/api/installation/owner/name": { agent: "request-installation-change" },
  "/api/installation/owner/custom-domain/change": { agent: "request-installation-change" },
  "/api/installation/owner/installation-type/change": { agent: "request-installation-change" },
  "/api/installation/owner/live-dev/change": { agent: "request-installation-change" },
  "/api/installation/owner/settings": { agent: "request-installation-change" },
  "/api/installation/owner/queued-actions/:id/decision": { agent: "request-installation-change" },

  // Stable source upgrades: requested by Builds, approved by the owner or the full grant.
  "/api/installation/owner/source-upgrades": { agent: "request-source-upgrade" },
  "/api/installation/owner/source-upgrades/:id/decision": { agent: "request-source-upgrade" },
};
