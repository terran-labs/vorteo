import type { AgentGrant, AgentGrantAction } from "@getpaseo/protocol/messages";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";

/** The only inbound operations an agent grant can authorize, and the action each needs. */
const INBOUND_ACTION: Readonly<Record<string, AgentGrantAction>> = {
  fetch_agent_request: "agent.read",
  fetch_agent_timeline_request: "agent.read",
  "agent.timeline.set_subscription.request": "agent.read",
  send_agent_message_request: "agent.message",
  cancel_agent_request: "agent.cancel",
};

/** Operations that address one agent; service sessions reach them only through grants. */
export const AGENT_GRANT_OPERATIONS: ReadonlySet<string> = new Set(Object.keys(INBOUND_ACTION));

/** Resolves an exact agent ID to its grant-relevant state; null when no such agent exists. */
export type AgentWorkspaceLookup = (agentId: string) => Promise<{
  workspaceId: string | undefined;
  internal: boolean;
  archived: boolean;
  /** True only when the daemon launches the agent with no tools at all. */
  toolLess: boolean;
} | null>;

/**
 * Enforces resource-scoped agent grants for a service session. Targets must be
 * exact agent IDs: prefix and title resolution would reveal other agents. Every
 * agent the session is allowed to touch is remembered, and outbound messages are
 * delivered only when each agent they name is one of those.
 */
export class AgentGrantGuard {
  private readonly permitted = new Set<string>();

  constructor(
    private readonly grants: readonly AgentGrant[],
    private readonly lookup: AgentWorkspaceLookup,
  ) {}

  handlesInbound(type: string): boolean {
    return type in INBOUND_ACTION;
  }

  async allowsInbound(message: SessionInboundMessage): Promise<boolean> {
    const action = INBOUND_ACTION[message.type];
    if (!action) return false;
    // Steering joins the current turn; interrupting would let a client discard
    // an owner's or another caller's run.
    if (message.type === "send_agent_message_request" && !isPlainSteeringMessage(message))
      return false;
    const targets = inboundTargets(message);
    for (const agentId of targets) {
      if (!(await this.allowsAgent(agentId, action))) return false;
    }
    for (const agentId of targets) this.permitted.add(agentId);
    return true;
  }

  allowsOutbound(message: SessionOutboundMessage): boolean {
    const agentIds = outboundAgentIds(message);
    return agentIds !== null && agentIds.every((agentId) => this.permitted.has(agentId));
  }

  private async allowsAgent(agentId: string, action: AgentGrantAction): Promise<boolean> {
    const matching = this.grants.filter((grant) => grant.actions.includes(action));
    if (matching.length === 0) return false;
    const agent = await this.lookup(agentId);
    // Internal agents are hidden from every listing and resolve differently, and
    // messaging an archived agent would unarchive it.
    if (!agent || agent.internal) return false;
    if (action === "agent.message" && agent.archived) return false;
    // Messages are delegated action and cancelling ends someone's turn, so both are
    // limited to tool-less agents. Checked on every request, so a later
    // reconfiguration is caught.
    if ((action === "agent.message" || action === "agent.cancel") && !agent.toolLess) return false;
    if (matching.some((grant) => grant.agentIds?.includes(agentId))) return true;
    const workspaceId = agent.workspaceId;
    return !!workspaceId && matching.some((grant) => grant.workspaceIds?.includes(workspaceId));
  }
}

/**
 * A granted message is steering text only: a session mode would change the agent's
 * configuration, attachments can name files, and sender attribution is not the
 * caller's to assert.
 */
function isPlainSteeringMessage(
  message: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>,
): boolean {
  return (
    message.activeTurnBehavior === "steer" &&
    // Slash text runs provider commands and skills (for example /rewind writes files).
    !message.text.trimStart().startsWith("/") &&
    message.origin === undefined &&
    message.sessionMode === undefined &&
    message.sourceAgentId === undefined &&
    message.sourceAgentServerId === undefined &&
    !message.images?.length &&
    !hasAttachments(message.attachments)
  );
}

function hasAttachments(attachments: unknown): boolean {
  if (attachments === undefined || attachments === null) return false;
  return Array.isArray(attachments) ? attachments.length > 0 : true;
}

function inboundTargets(message: SessionInboundMessage): string[] {
  switch (message.type) {
    case "agent.timeline.set_subscription.request":
      return message.agentIds;
    case "fetch_agent_request":
    case "fetch_agent_timeline_request":
    case "send_agent_message_request":
    case "cancel_agent_request":
      return [message.agentId];
    default:
      return [];
  }
}

/** Agent IDs an outbound message concerns, or null when it is not deliverable under a grant. */
function outboundAgentIds(message: SessionOutboundMessage): string[] | null {
  switch (message.type) {
    case "fetch_agent_response":
      return message.payload.agent ? [message.payload.agent.id] : [];
    case "fetch_agent_timeline_response":
    case "send_agent_message_response":
    case "agent_stream":
      return [message.payload.agentId];
    case "cancel_agent_response":
      return [message.payload.agentId];
    case "agent.timeline.set_subscription.response":
      return message.payload.agentIds;
    case "rpc_error":
      return [];
    default:
      return null;
  }
}
