import type {
  QueueAttachment,
  QueueOperation,
  QueueSnapshot,
} from "@getpaseo/protocol/message-queue";
import {
  OutboxRecordSchema,
  canKeepRejectedChange,
  outboxKey,
  type LocalQueueAttachment,
  type OutboxKey,
  type OutboxRecord,
  type OutboxStorage,
} from "./outbox-record";

export interface QueueOutboxPort {
  upload(serverId: string, attachment: LocalQueueAttachment): Promise<QueueAttachment>;
  mutate(
    serverId: string,
    agentId: string,
    operation: QueueOperation,
  ): Promise<{
    snapshot: QueueSnapshot | null;
    error: { code: string; message: string } | null;
  }>;
  changed(snapshot: QueueSnapshot, serverId: string): void;
  /** Reads current host state so content-free commands can settle revision conflicts. */
  read?(serverId: string, agentId: string): Promise<QueueSnapshot>;
  localChanged?(serverId: string, flush: boolean): void;
  acknowledged?(record: OutboxRecord): Promise<void>;
  discarded?(record: OutboxRecord): Promise<void>;
}

export class QueueOutbox {
  constructor(
    private readonly storage: OutboxStorage,
    private readonly port: QueueOutboxPort,
  ) {}

  private notifyLocalChange(serverId: string, flush: boolean): void {
    // A UI/broadcast failure cannot turn a committed transaction into a failed
    // submission and encourage the composer to send the same text again.
    try {
      this.port.localChanged?.(serverId, flush);
    } catch {
      /* Foreground refresh recovers. */
    }
  }

  // Callers may clear the composer only after this transaction completes.
  async commit(input: {
    serverId: string;
    agentId: string;
    createdAt: number;
    operation: QueueOperation;
    localAttachments: LocalQueueAttachment[];
  }): Promise<void> {
    if (
      input.localAttachments.length &&
      input.operation.kind !== "enqueue" &&
      input.operation.kind !== "edit"
    ) {
      throw new Error("Only message content operations may include attachments");
    }
    const record = OutboxRecordSchema.parse({
      ...input,
      version: 1,
      revision: 0,
      error: null,
      prepared: input.localAttachments.length ? null : input.operation,
    });
    if (!(await this.storage.exchange(outboxKey(record), null, record))) {
      throw new Error("This operation is already in the message outbox");
    }
    this.notifyLocalChange(input.serverId, true);
  }

  async list(): Promise<OutboxRecord[]> {
    return (await this.storage.list()).sort(
      (a, b) =>
        (a.order ?? a.createdAt) - (b.order ?? b.createdAt) ||
        a.operation.operationId.localeCompare(b.operation.operationId),
    );
  }

  async retry(key: OutboxKey): Promise<void> {
    const record = await this.storage.read(key);
    if (!record?.error || record.dismissed) return;
    // Resending a stale pause or resume repeats the same conflict. The owner asked
    // again after seeing the current queue, so apply it to that state instead.
    if (isPauseConflict(record) && (await this.settlePauseConflict(record, true))) return;
    await this.storage.exchange(key, record.revision, {
      ...record,
      revision: record.revision + 1,
      error: null,
    });
    this.notifyLocalChange(key.serverId, true);
  }

  async reconcile(serverId: string, snapshot: QueueSnapshot): Promise<void> {
    for (const record of await this.list()) {
      const operation = record.operation;
      const obsolete =
        record.serverId === serverId &&
        record.agentId === snapshot.agentId &&
        operation.kind === "send_now" &&
        record.error !== null &&
        ["missing", "delivery_conflict", "revision_conflict"].includes(record.error.code) &&
        record.localAttachments.length === 0 &&
        !snapshot.items.some((item) => item.id === operation.messageId);
      if (!obsolete) continue;
      // This command contains no user content and can no longer target a message.
      // Compare revisions so another tab's retry cannot be removed underneath it.
      if (await this.storage.exchange(outboxKey(record), record.revision, null))
        this.notifyLocalChange(serverId, true);
    }
  }

  async flush(serverId: string): Promise<void> {
    const blocked = new Set<string>();
    for (const candidate of await this.list()) {
      if (candidate.serverId !== serverId) continue;
      const canRepairQueue = ["delete", "pause", "resolve"].includes(candidate.operation.kind);
      if (blocked.has(candidate.agentId) && !canRepairQueue) continue;
      const key = outboxKey(candidate);
      const record = await this.storage.read(key);
      if (!record || record.dismissed) continue;
      if (!record.error && (await this.deliver(record))) continue;
      const failed = await this.storage.read(key);
      if (failed && isPauseConflict(failed)) {
        const settled = await this.settlePauseConflict(failed, false);
        // A rebased pause still precedes later operations; the next pass sends it first.
        if (settled === "rebased") blocked.add(failed.agentId);
        if (settled) continue;
      }
      // A rejected resume leaves the queue paused, where later messages wait safely on
      // the host. Holding them on this device would hide them from every other client.
      if (failed?.operation.kind === "pause" && !failed.operation.paused) continue;
      blocked.add(candidate.agentId);
    }
  }

  async dismissCommand(key: OutboxKey): Promise<void> {
    const record = await this.storage.read(key);
    if (!record?.error || hasMessageContent(record))
      throw new Error("Only a rejected command without message content can be dismissed.");
    if (!(await this.storage.exchange(key, record.revision, null)))
      throw new Error("The pending change was updated on another tab. Review it again.");
    this.notifyLocalChange(key.serverId, true);
  }

  /**
   * Pause and resume carry no message content and are refused whenever any queue
   * change moved its revision, including an ordinary dispatch. Drop one the queue
   * already satisfies. Reissue a pause, which is always safe, against current state.
   * A resume is reissued only when the owner retries: a Stop may have paused the
   * queue after they asked to resume.
   */
  private async settlePauseConflict(
    record: OutboxRecord,
    resume: boolean,
  ): Promise<"removed" | "rebased" | null> {
    const operation = record.operation;
    if (operation.kind !== "pause" || !this.port.read) return null;
    let current: QueueSnapshot;
    try {
      current = await this.port.read(record.serverId, record.agentId);
    } catch {
      return null;
    }
    const key = outboxKey(record);
    if (current.paused === operation.paused) {
      if (!(await this.storage.exchange(key, record.revision, null))) return null;
      this.notifyLocalChange(record.serverId, false);
      return "removed";
    }
    if (!operation.paused && !resume) return null;
    const operationId = rebasedOperationId(operation.operationId);
    if (!operationId) return null;
    const rebased = { ...operation, operationId, expectedRevision: current.revision };
    const next: OutboxRecord = {
      ...record,
      // Keep its sort key so messages queued after the pause cannot overtake it.
      order: record.order ?? record.createdAt,
      revision: 0,
      operation: rebased,
      prepared: rebased,
      error: null,
      dismissed: undefined,
    };
    // Insert before removing: an interruption leaves the stale copy, which the next
    // pass drops once the reissued command applies. Another tab may settle the same
    // conflict meanwhile; then withdraw this copy so only one reissue reaches the host.
    if ((await this.storage.read(key))?.revision !== record.revision) return null;
    const nextKey = outboxKey(next);
    if (!(await this.storage.exchange(nextKey, null, next))) return null;
    if (!(await this.storage.exchange(key, record.revision, null))) {
      await this.storage.exchange(nextKey, 0, null);
      return null;
    }
    this.notifyLocalChange(record.serverId, true);
    return "rebased";
  }

  async keepRejectedCopy(key: OutboxKey): Promise<void> {
    const record = await this.storage.read(key);
    if (!record || !canKeepRejectedChange(record))
      throw new Error("Only a rejected change can be kept without synchronizing it.");
    if (
      !(await this.storage.exchange(key, record.revision, {
        ...record,
        revision: record.revision + 1,
        dismissed: true,
      }))
    )
      throw new Error("The pending change was updated on another tab. Review it again.");
    this.notifyLocalChange(key.serverId, true);
  }

  async removeRejectedCopy(key: OutboxKey): Promise<void> {
    const record = await this.storage.read(key);
    if (!record?.dismissed)
      throw new Error("This operation still owns an unsynchronized message or attachment.");
    if (!(await this.storage.exchange(key, record.revision, null)))
      throw new Error("The local copy changed. Review it again.");
    await this.port.discarded?.(record);
    this.notifyLocalChange(key.serverId, false);
  }

  private async prepare(record: OutboxRecord): Promise<OutboxRecord | null> {
    if (record.prepared) return record;
    const operation = record.operation;
    if (operation.kind !== "enqueue" && operation.kind !== "edit")
      throw new Error("Invalid staged message operation");
    const attachments = [...operation.attachments];
    for (const local of record.localAttachments)
      attachments.push(await this.port.upload(record.serverId, local));
    const next: OutboxRecord = {
      ...record,
      revision: record.revision + 1,
      prepared: { ...operation, attachments },
    };
    const key = outboxKey(record);
    if (await this.storage.exchange(key, record.revision, next)) return next;
    // Another tab may have uploaded different remote IDs. Only the winner's exact
    // persisted operation can be sent with this idempotency key.
    return this.storage.read(key);
  }

  private async deliver(pending: OutboxRecord): Promise<boolean> {
    const record = await this.prepare(pending);
    if (!record) return true;
    if (record.error || !record.prepared) return false;
    const result = await this.port.mutate(record.serverId, record.agentId, record.prepared);
    const key = outboxKey(record);
    if (result.error) {
      await this.storage.exchange(key, record.revision, {
        ...record,
        revision: record.revision + 1,
        error: result.error,
      });
      // Rejections can include a newer queue after another client delivered or
      // changed a message. Keep the local operation, but refresh its server state.
      if (result.snapshot) this.port.changed(result.snapshot, record.serverId);
      this.notifyLocalChange(record.serverId, false);
      return false;
    }
    if (!result.snapshot) throw new Error("Host did not acknowledge the queue operation");
    const removed = await this.storage.exchange(key, record.revision, null);
    this.port.changed(result.snapshot, record.serverId);
    if (removed) {
      this.notifyLocalChange(record.serverId, false);
      await this.port.acknowledged?.(record);
    }
    return true;
  }
}

const MAX_PAUSE_REBASES = 5;

// operation_conflict means another tab already sent the same reissued pause.
function isPauseConflict(record: OutboxRecord): boolean {
  const code = record.error?.code;
  return (
    record.operation.kind === "pause" &&
    (code === "revision_conflict" || code === "operation_conflict")
  );
}

function hasMessageContent(record: OutboxRecord): boolean {
  return record.operation.kind === "enqueue" || record.operation.kind === "edit";
}

// Deterministic, so two tabs settling the same conflict write the same record once.
// Bounded, so a queue that changes on every attempt leaves the conflict for the owner.
function rebasedOperationId(operationId: string): string | null {
  const match = /^(.*)~r(\d+)$/.exec(operationId);
  const base = match ? match[1] : operationId;
  const count = match ? Number(match[2]) + 1 : 1;
  return count > MAX_PAUSE_REBASES ? null : `${base}~r${count}`;
}
