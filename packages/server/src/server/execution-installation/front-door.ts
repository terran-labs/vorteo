/**
 * The front door for every owner-authenticated installation route that changes something.
 * Each route either has an agent request command in scripts/installation-agent.mjs, which
 * Builds uses and the full maintenance grant can approve (see OWNER_ONLY_OPERATIONS), or a
 * stated reason it stays with the owner. A new owner route fails the front-door test until it
 * is listed here, so a new lifecycle or settings operation cannot ship owner-only by default.
 * Read-only routes ending in `/query` are exempt without an entry.
 */
export type FrontDoor = { agent: string } | { exempt: string };

const GRANT =
  "Grant management: agents never grant, widen or choose their own authority, so it stays with the owner.";
const SESSION = "Owner sign-in and session control; agents never hold an owner session.";
const READ = "Read-only owner view; it changes nothing.";
const UPGRADES =
  "Release upgrades follow the owner's update policy, whose automatic mode approves them without an owner click.";
const CREDENTIALS =
  "Accounts and credentials: the full maintenance grant never alters accounts or credentials.";
const GUARDRAILS =
  "Installation-wide agent settings, which include agent instructions: agents never edit their own guardrails (owner decision 2026-11-07).";
const MANAGEMENT =
  "Owner cancellation; agents cancel retained requests through management-cancel instead.";
const OBSERVE =
  "Re-reads an uncertain outcome that every queue drain also observes; it approves nothing.";
const OWNER_ONLY_TODAY =
  "Owner-only today with no agent request route. Tracked gap: add an agent command and delegated admission.";

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
  // Agents request it; OWNER_ONLY_OPERATIONS keeps its approval with the owner.
  "/api/installation/owner/instruction-requests/decision": { agent: "request-instructions" },

  "/api/installation/owner/maintenance-delegation/change": { exempt: GRANT },
  "/api/installation/owner/maintenance-permissions/change": { exempt: GRANT },
  "/api/installation/owner/daemon-automation/change": { exempt: GRANT },
  "/api/installation/owner/session": { exempt: SESSION },
  "/api/installation/owner/lock": { exempt: SESSION },
  "/api/installation/owner/unlock": { exempt: SESSION },
  "/api/installation/owner/restarts/impact": { exempt: READ },
  "/api/installation/owner/profiles/read": { exempt: READ },
  "/api/installation/owner/settings/read": { exempt: READ },
  "/api/installation/owner/settings/skills/preview": { exempt: READ },
  "/api/installation/owner/upgrades": { exempt: UPGRADES },
  "/api/installation/owner/upgrades/:id/decision": { exempt: UPGRADES },
  "/api/installation/owner/update-policy": { exempt: UPGRADES },
  "/api/installation/owner/update-check": { exempt: UPGRADES },
  "/api/installation/owner/connections": { exempt: CREDENTIALS },
  "/api/installation/owner/profiles": { exempt: CREDENTIALS },
  "/api/installation/owner/profiles/resolve": { exempt: CREDENTIALS },
  "/api/installation/owner/profiles/synchronize": { exempt: CREDENTIALS },
  "/api/installation/owner/settings": { exempt: GUARDRAILS },
  "/api/installation/owner/settings/plugins/resolve": { exempt: GUARDRAILS },
  "/api/installation/owner/settings/skills/package": { exempt: GUARDRAILS },
  "/api/installation/owner/settings/skills/prepare": { exempt: GUARDRAILS },
  "/api/installation/owner/maintenance-services/cancel": { exempt: MANAGEMENT },
  "/api/installation/owner/broker-deployments/observe": { exempt: OBSERVE },
  "/api/installation/owner/helpers/verify-installed": { exempt: OWNER_ONLY_TODAY },
  "/api/installation/owner/dev-repair/prepare": { exempt: OWNER_ONLY_TODAY },
  "/api/installation/owner/name": { exempt: OWNER_ONLY_TODAY },
  "/api/installation/owner/custom-domain/change": { exempt: OWNER_ONLY_TODAY },
  "/api/installation/owner/installation-type/change": { exempt: OWNER_ONLY_TODAY },
  "/api/installation/owner/live-dev/change": { exempt: OWNER_ONLY_TODAY },
  "/api/installation/owner/snapshots": { exempt: OWNER_ONLY_TODAY },
  "/api/installation/owner/snapshots/restore": { exempt: OWNER_ONLY_TODAY },
};
