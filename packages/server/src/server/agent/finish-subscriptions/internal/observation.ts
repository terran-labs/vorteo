import type { Logger } from "pino";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentStorage } from "../../agent-storage.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { buildStoredAgentPayload, toAgentPayload } from "../../agent-projections.js";
import { serializeSnapshotWithMetadata } from "../../mcp-shared.js";
import { createHostObservationResolver, type ToolHosts } from "../../host-operations/index.js";
import { openFinishObservation } from "./observation-stream.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { FinishObservation } from "../index.js";
import type { StoredAgentRecord } from "../../agent-storage.js";
import { NOT_RUNNING_CANCEL_REASON, REOPEN_FAILED_CANCEL_REASON } from "./observation-buffer.js";
import { ensureAgentLoaded } from "../../agent-loading.js";
import { setTimeout as pause } from "node:timers/promises";

const ADOPTION_POLL_MS = 250;

/**
 * A child closed at rest without an archive: a daemon restart or an idle release closed it, and it
 * reopens on demand. That is not its end, so watchers wait for its next live outcome instead.
 */
function closedAtRest(stored: StoredAgentRecord | null): boolean {
  return stored?.lastStatus === "closed" && !stored.archivedAt;
}
const notSettled = { status: "timeout", final: null, lastMessage: null, error: null } as const;

export function createFinishObservation(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** A child chosen for restart recovery reports its state only after its resume was sent. */
  waitForResume(agentId: string, signal: AbortSignal): Promise<void>;
  messages(): AgentMessageDelivery;
  hosts(): ToolHosts;
  /** A hosted session still running a turn that this daemon will adopt after startup. */
  pendingAdoption?(agentId: string): boolean;
  serverId: string;
  logger: Logger;
}): FinishObservation {
  const { agentManager, agentStorage } = input;
  type Publish = (snapshot: AgentSnapshotPayload | null, event?: AgentStreamEvent) => void;
  /**
   * Resolves a child whose hosted session was pending adoption when the watch opened. A busy
   * child reports through live events. An idle one may have finished during the restart, which
   * the load applies as history without a live completion, so it is reported here. A child that
   * cannot be reopened ends the watch with an honest notice instead of waiting forever.
   */
  async function followAdoption(agentId: string, signal: AbortSignal, publish: Publish) {
    const adopting = () =>
      input.pendingAdoption?.(agentId) === true && !agentManager.getAgent(agentId);
    while (adopting()) await pause(ADOPTION_POLL_MS, undefined, { signal });
    let current;
    try {
      // Joins the adoption load when it is still in flight, or takes over a released session.
      current = await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger: input.logger,
      });
    } catch (error) {
      signal.throwIfAborted();
      input.logger.warn({ err: error, agentId }, "A watched child could not be reopened");
      const stored = await agentStorage.get(agentId);
      // An archived or deleted child reports closed or unavailable as usual.
      if (!stored || stored.archivedAt)
        publish(stored ? buildStoredAgentPayload(stored, [stored.provider]) : null);
      else
        publish(
          { ...buildStoredAgentPayload(stored, [stored.provider]), status: "idle" },
          { type: "turn_canceled", provider: stored.provider, reason: REOPEN_FAILED_CANCEL_REASON },
        );
      return;
    }
    if (current.lifecycle === "idle" && !agentManager.hasInFlightRun(agentId))
      publish(toAgentPayload(current, { title: current.config.title ?? undefined }), {
        type: "turn_completed",
        provider: current.provider,
      });
  }
  const resolver = createHostObservationResolver({
    serverId: input.serverId,
    hosts: input.hosts,
    local: {
      async wait(agentId, signal) {
        await input.waitForResume(agentId, signal);
        await input.messages().waitForDispatch(agentId, signal);
        signal.throwIfAborted();
        const live = agentManager.getAgent(agentId);
        if (!live) {
          // An adopted session reports its turn live once loaded; the continuous observation
          // carries a child at rest. Neither has settled here.
          if (input.pendingAdoption?.(agentId)) return notSettled;
          const stored = await agentStorage.get(agentId);
          if (closedAtRest(stored)) return notSettled;
          return {
            status: stored?.lastStatus === "error" ? "error" : "idle",
            final: stored ? buildStoredAgentPayload(stored, [stored.provider]) : null,
            lastMessage: await agentManager.getLastAssistantMessage(agentId),
            error: stored?.lastError ?? null,
          };
        }
        const result = await agentManager.waitForAgentEvent(agentId, {
          signal,
          waitForActive: true,
        });
        const current = agentManager.getAgent(agentId);
        const status = result.permission ? "permission" : result.status;
        return {
          status: status === "permission" || status === "error" ? status : "idle",
          final: current
            ? await serializeSnapshotWithMetadata(agentStorage, current, input.logger)
            : null,
          lastMessage: result.lastMessage,
          error: current?.lastError ?? null,
        };
      },
      async observe(agentId, handler, signal, onError) {
        await input.waitForResume(agentId, signal);
        const stored = await agentStorage.get(agentId);
        let updates = Promise.resolve();
        const publish = (snapshot: AgentSnapshotPayload | null, event?: AgentStreamEvent) => {
          updates = updates
            .then(async () =>
              handler(snapshot, event, await agentManager.getLastAssistantMessage(agentId)),
            )
            .catch(onError);
        };
        signal.throwIfAborted();
        const unsubscribe = agentManager.subscribe(
          (event) => {
            // An automatic release closes a runtime that reopens on demand; it is not the end.
            if (
              event.type === "agent_state" &&
              event.agent.lifecycle === "closed" &&
              agentManager.isReleasingRuntime(agentId)
            )
              return;
            if (event.type === "agent_state" && event.agent.lifecycle !== "idle")
              publish(toAgentPayload(event.agent, { title: stored?.title }));
            else if (
              event.type === "agent_stream" &&
              [
                "permission_requested",
                "permission_resolved",
                "turn_started",
                "turn_completed",
                "turn_canceled",
                "turn_failed",
              ].includes(event.event.type)
            ) {
              const current = agentManager.getAgent(agentId);
              if (current) publish(toAgentPayload(current, { title: stored?.title }), event.event);
            }
          },
          { agentId, replayState: false },
        );
        const current = agentManager.getAgent(agentId);
        if (current)
          publish(toAgentPayload(current, { title: stored?.title }), {
            type: "turn_started",
            provider: current.provider,
          });
        else if (input.pendingAdoption?.(agentId))
          // Its turn is still running in the session host; follow the adoption load.
          void followAdoption(agentId, signal, publish).catch((error: unknown) => {
            if (!signal.aborted) onError(error);
          });
        else if (stored && closedAtRest(stored))
          // Tell the watcher once that the child is not running; the subscription stays armed.
          publish(
            { ...buildStoredAgentPayload(stored, [stored.provider]), status: "idle" },
            {
              type: "turn_canceled",
              provider: stored.provider,
              reason: NOT_RUNNING_CANCEL_REASON,
            },
          );
        else publish(stored ? buildStoredAgentPayload(stored, [stored.provider]) : null);
        const stop = () => unsubscribe();
        signal.addEventListener("abort", stop, { once: true });
        return async () => {
          signal.removeEventListener("abort", stop);
          unsubscribe();
        };
      },
    },
  });
  return { open: (record, signal) => openFinishObservation(resolver, record, signal) };
}
