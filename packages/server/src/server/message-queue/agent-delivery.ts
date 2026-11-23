import type { Logger } from "pino";
import type { QueueAttachmentStore } from "./attachments.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { buildConfigOverrides } from "../persistence-hooks.js";
import type { QueueDeliveryPort } from "./delivery.js";

interface AgentDeliveryOptions {
  attachments: QueueAttachmentStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  /** Reads a saved transcript without starting the provider; omitted, history loads the agent. */
  providerSnapshotManager?: Pick<
    ProviderSnapshotManager,
    "readSessionHistory" | "getAgentManagerProviderState"
  >;
}

/** Provider families whose saved transcript replays the whole thread without resuming it. */
const PASSIVE_HISTORY_FAMILIES = new Set(["claude", "codex"]);

function readsPassively(
  providers: NonNullable<AgentDeliveryOptions["providerSnapshotManager"]>,
  provider: string,
): boolean {
  const { providerDefinitions } = providers.getAgentManagerProviderState();
  const seen = new Set<string>();
  let current = provider;
  while (!seen.has(current)) {
    seen.add(current);
    const base = providerDefinitions[current]?.derivedFromProviderId;
    if (!base) break;
    current = base;
  }
  return PASSIVE_HISTORY_FAMILIES.has(current);
}

async function readSavedHistory(
  providers: NonNullable<AgentDeliveryOptions["providerSnapshotManager"]>,
  record: StoredAgentRecord,
): Promise<AgentStreamEvent[] | null> {
  const persistence = record.persistence?.sessionId ? record.persistence : null;
  if (!persistence || !readsPassively(providers, persistence.provider)) return null;
  const events: AgentStreamEvent[] = [];
  for await (const event of providers.readSessionHistory(persistence, {
    ...buildConfigOverrides(record),
    provider: record.provider,
    cwd: record.cwd,
  }))
    events.push(event);
  return events;
}

export function createAgentQueueDelivery(
  options: AgentDeliveryOptions,
): Omit<QueueDeliveryPort, "changed"> {
  const { agentManager, agentStorage, logger } = options;
  return {
    canStartWork: () => !agentManager.isRestartDraining(),
    async recoveryAgentIds() {
      const records = await agentStorage.list();
      return records
        .filter((record) => !record.archivedAt && record.queueGoalHold)
        .map((record) => record.id);
    },
    async history(agentId) {
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt) return null;
      // Settling an uncertain message must not resume a closed runtime: a resume changes the
      // agent's state, which wakes this queue again, and the next idle release closes it.
      const live = agentManager.getAgent(agentId);
      if (!live?.session && options.providerSnapshotManager) {
        const saved = await readSavedHistory(options.providerSnapshotManager, record);
        if (saved) return saved;
      }
      const agent = live?.session ? live : await ensureUnarchivedAgentLoaded(agentId, options);
      if (!agent.session) return null;
      const events: AgentStreamEvent[] = [];
      for await (const event of agent.session.streamHistory()) events.push(event);
      return events;
    },
    needsCompletion: (agentId) => agentManager.getAgent(agentId)?.queueGoalHold !== undefined,
    abandonGoal: (agentId) => agentManager.releaseQueueGoalHold(agentId),
    async complete(agentId, queueIsEmpty, canContinueGoal) {
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt || !record.queueGoalHold) return;
      if (record.queueGoalHold.phase !== "held")
        throw new Error(
          "A goal change could not be confirmed. Review and set the task goal before continuing.",
        );
      const agent = await ensureUnarchivedAgentLoaded(agentId, options);
      if (agent.session?.goals)
        await agentManager.resumeGoalAfterQueuedMessages(agentId, queueIsEmpty, canContinueGoal);
    },
    async prepare(agentId, item, canStart, canHoldGoal = canStart) {
      if (agentManager.isRestartDraining()) return false;
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt) return false;
      const agent = await ensureUnarchivedAgentLoaded(agentId, options);
      if (item.sendNow && agent.activeTurnId !== item.sendNow.expectedTurnId)
        throw new Error("The active turn changed. Review the task before sending now.");
      if (agent.queueGoalHold && agent.queueGoalHold.phase !== "held")
        throw new Error(
          "A goal change could not be confirmed. Review and set the task goal before continuing.",
        );
      if (agent.session?.goals) {
        await agentManager.pauseGoalForQueuedMessages(agentId, canHoldGoal);
      }
      if (agentManager.isRestartDraining()) return false;
      await agentManager.prepareQuotaReserveAdmission(agentId);
      return !!item.sendNow || (agent.lifecycle === "idle" && agent.pendingPermissions.size === 0);
    },
    load: (item) => options.attachments.prompt(item),
    start(agentId, item, prompt, canStart) {
      if (item.sendNow) return agentManager.startQueuedMessageNow(agentId, prompt, item, canStart);
      return agentManager.startQueuedMessage(agentId, prompt, item);
    },
    failed(error, agentId) {
      logger.error({ err: error, agentId }, "Queued message delivery stopped");
    },
  };
}
