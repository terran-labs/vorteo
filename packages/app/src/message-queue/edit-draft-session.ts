import {
  QUEUE_EDIT_HOLD_EXPIRED_CODE,
  type QueueEditHoldOperation,
  type QueueItem,
  type QueueSnapshot,
} from "@getpaseo/protocol/message-queue";
import {
  type QueueEditDraft,
  type QueueEditDraftStorage,
  draftHasContent,
  validateDraftAttachments,
} from "./edit-draft";

/** A daemon refusal of a hold operation, as opposed to a transport failure. */
export class QueueEditHoldRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QueueEditHoldRefusedError";
  }
}

/** The snapshot from a hold response, or its daemon refusal as a QueueEditHoldRefusedError. */
export function editHoldSnapshot(result: {
  snapshot: QueueSnapshot | null;
  error: { code: string; message: string } | null;
}): QueueSnapshot {
  if (result.error) throw new QueueEditHoldRefusedError(result.error.code, result.error.message);
  if (!result.snapshot) throw new Error("Queue state is unavailable.");
  return result.snapshot;
}

export interface QueueEditDraftPort {
  storage: QueueEditDraftStorage;
  identity(): string;
  commit(draft: QueueEditDraft): Promise<void>;
  cleanup(draft: QueueEditDraft): Promise<void>;
  editHold?: QueueEditHoldPort;
}

/** Holds the queued message from delivery while it is edited, on daemons that support it. */
export interface QueueEditHoldPort {
  supported(serverId: string): boolean;
  send(serverId: string, agentId: string, operation: QueueEditHoldOperation): Promise<void>;
}

/** The daemon releases a hold two minutes after its last renewal. */
export const EDIT_HOLD_RENEWAL_MS = 30_000;

// Drafts are independently identified: two tabs can edit the same message without
// overwriting each other's unsaved work. The server revision arbitrates Save.
export class QueueEditDraftSession {
  constructor(private readonly port: QueueEditDraftPort) {}

  /** With `hold`, a refused hold, such as another window editing the message, opens no draft. */
  async open(
    serverId: string,
    agentId: string,
    item: QueueItem,
    options: { hold: boolean } = { hold: true },
  ): Promise<QueueEditDraft> {
    const draft: QueueEditDraft = {
      version: 1,
      id: this.port.identity(),
      serverId,
      agentId,
      revision: 0,
      original: item,
      text: item.text,
      attachments: item.attachments,
      localAttachments: [],
      submissionId: null,
    };
    if (options.hold) await this.renew(draft);
    if (!(await this.port.storage.exchange(draft, null)))
      throw new Error("Could not create the queue edit.");
    return draft;
  }

  async update(
    current: QueueEditDraft,
    changes: Pick<QueueEditDraft, "text" | "attachments" | "localAttachments">,
  ): Promise<QueueEditDraft> {
    if (current.submissionId)
      throw new Error(
        "This edit has already been submitted. Review its synchronization status first.",
      );
    const next = { ...current, ...changes, revision: current.revision + 1 };
    validateDraftAttachments(next);
    if (!(await this.port.storage.exchange(next, current.revision)))
      throw new Error(
        "This draft changed in another tab. Your current edit has not overwritten it.",
      );
    return next;
  }

  /** Acquires or renews the hold. The draft identity is the holder, shared by tabs showing it. */
  async renew(draft: QueueEditDraft): Promise<void> {
    const hold = this.port.editHold;
    if (!hold?.supported(draft.serverId)) return;
    await hold.send(draft.serverId, draft.agentId, {
      kind: "hold_edit",
      operationId: this.port.identity(),
      messageId: draft.original.id,
      expectedRevision: draft.original.revision,
      holderId: draft.id,
    });
  }

  /**
   * Keeps the hold while an editor shows the draft: acquires now, then renews every 30 seconds,
   * reporting a refusal once. After the daemon refuses renewal at its maximum hold, renewing
   * stops until the editor opens again, so the abandoned edit sends as written. Stopping only
   * stops renewing. It never releases: the draft
   * outlives its editor and tabs showing it share the holder, so only a discard releases, and
   * an editor that closed is covered by the daemon's expiry.
   */
  keepHeld(
    current: () => QueueEditDraft,
    report: (error: unknown) => void,
    schedule: (renew: () => void) => () => void = (renew) => {
      const timer = setInterval(renew, EDIT_HOLD_RENEWAL_MS);
      return () => clearInterval(timer);
    },
  ): () => void {
    let reported = false;
    let capped = false;
    const renew = () => {
      if (capped) return;
      void this.renew(current()).then(
        () => {
          reported = false;
          return;
        },
        (error: unknown) => {
          if (
            error instanceof QueueEditHoldRefusedError &&
            error.code === QUEUE_EDIT_HOLD_EXPIRED_CODE
          )
            capped = true;
          if (!reported) report(error);
          reported = true;
        },
      );
    };
    renew();
    return schedule(renew);
  }

  async release(draft: QueueEditDraft): Promise<void> {
    const hold = this.port.editHold;
    if (!hold?.supported(draft.serverId)) return;
    await hold.send(draft.serverId, draft.agentId, {
      kind: "release_edit",
      operationId: this.port.identity(),
      messageId: draft.original.id,
      holderId: draft.id,
    });
  }

  async discard(draft: QueueEditDraft): Promise<void> {
    await this.remove(draft);
    // An unreleased hold still expires, so a failed release never blocks the queue for long.
    await this.release(draft).catch(() => undefined);
  }

  private async remove(draft: QueueEditDraft): Promise<void> {
    if (!(await this.port.storage.remove(draft.id, draft.revision)))
      throw new Error(
        "This draft changed in another tab. Reload its saved copy before discarding it.",
      );
    await this.port.cleanup(draft);
  }

  async save(draft: QueueEditDraft): Promise<void> {
    if (draft.submissionId)
      throw new Error(
        "This edit may already be saved. Check the queue before submitting another edit.",
      );
    if (!draftHasContent(draft))
      throw new Error("Add text, an attachment, or context before saving.");
    validateDraftAttachments(draft);
    const submitted = {
      ...draft,
      revision: draft.revision + 1,
      submissionId: this.port.identity(),
    };
    if (!(await this.port.storage.exchange(submitted, draft.revision)))
      throw new Error("This draft changed in another tab. Review its saved copy before sending.");
    // A crash after commit but before removal leaves a visible submitted draft.
    // Never automatically replay it: acknowledgement may already have removed the outbox record.
    await this.port.commit(submitted);
    // The submitted edit releases the hold on the daemon. Releasing here could reach it
    // before the edit and let the unedited text be delivered.
    await this.remove(submitted);
  }
}
