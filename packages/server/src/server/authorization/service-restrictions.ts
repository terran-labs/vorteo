import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import type { z } from "zod";
import type { DaemonPermission, SessionRestrictions } from "./index.js";

/**
 * Permissions a service principal may hold today. Daemon-wide `workspace.read` is
 * safe only together with the path restriction below. `daemon.read` is excluded
 * because daemon configuration carries provider environment variables, and write,
 * manage and access permissions are owner-equivalent until resource-scoped grants
 * ship.
 */
export const GRANTABLE_SERVICE_PERMISSIONS: readonly DaemonPermission[] = ["workspace.read"];

// Field names that address the daemon's filesystem. File reads, git and terminal
// operations take an arbitrary cwd or path, so without workspace-scoped enforcement
// they would read any file the daemon can, including its owner credential.
const PATH_FIELD =
  /^(cwd|cwds|path|paths|root|rootPath|directory|dir|repoRoot|repoPath|projectPath|workspaceDirectory|filePath|fileName|target)$/i;
const MAX_DEPTH = 4;

// Operations that act on owner-wide state despite being classified as reads:
// presence suppresses the owner's push alerts, push tokens outlive revocation,
// forge search uses the owner's sign-in and suggestions reveal provider history.
const OWNER_STATE_OPERATIONS = [
  "client_heartbeat",
  "register_push_token",
  "push.unregister.request",
  "workspace.github.search_repositories.request",
  "project.suggestions.request",
];

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    const def = current._def as { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    const inner = def.innerType ?? def.schema;
    if (!inner) return current;
    current = inner;
  }
}

function addressesPaths(schema: z.ZodTypeAny, depth: number): boolean {
  const unwrapped = unwrap(schema);
  const shape = (unwrapped as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!shape || depth > MAX_DEPTH) return false;
  return Object.entries(shape).some(
    ([key, value]) => PATH_FIELD.test(key) || addressesPaths(value, depth + 1),
  );
}

function computeServiceDeniedOperations(): ReadonlySet<string> {
  const denied = new Set<string>(OWNER_STATE_OPERATIONS);
  for (const option of SessionInboundMessageSchema.options) {
    const type = option.shape.type.value as string;
    // Connected-host routing forwards only permissions, not this restriction.
    // Terminal output can show secrets that were typed or printed.
    if (type.startsWith("hosts.") || /terminal/.test(type) || addressesPaths(option, 0))
      denied.add(type);
  }
  return denied;
}

/** Inbound operations a service principal can never perform, regardless of its permissions. */
export const SERVICE_DENIED_OPERATIONS = computeServiceDeniedOperations();

/**
 * The only inbound operations a service session may send. Everything else is
 * refused before permissions are considered, so a new operation stays closed to
 * service principals until it is reviewed and added here. Permissions or agent
 * grants still decide each allowed operation.
 */
export const SERVICE_ALLOWED_OPERATIONS: ReadonlySet<string> = new Set([
  // Observation with workspace.read.
  "project.list.request",
  "fetch_workspaces_request",
  "fetch_agents_request",
  // Agent grants: agent.read, agent.message and agent.cancel.
  "fetch_agent_request",
  "fetch_agent_timeline_request",
  "agent.timeline.set_subscription.request",
  "send_agent_message_request",
  "cancel_agent_request",
  // Releasing the session's own subscriptions.
  "subscription.release.request",
]);

/** Service sessions reach only allowlisted operations, never path-addressed, routed or owner-state ones. */
export function sessionRestrictionsFor(
  principalId: string | null | undefined,
): SessionRestrictions | undefined {
  return principalId?.startsWith("service:")
    ? { allowedInbound: SERVICE_ALLOWED_OPERATIONS, deniedInbound: SERVICE_DENIED_OPERATIONS }
    : undefined;
}
