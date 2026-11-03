import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { coordinatorDispatchStatuses } from "./coordinator-bootstrap-dispatch-status.js";

/** Failures older than this when notification is first enabled are history, not news.
 * `failedAt` is when the coordinator closed the failed approval, not when it was approved. */
const FAILURE_NOTICE_WINDOW_MS = 24 * 60 * 60_000;
const RETAINED_NOTICES = 128;
const NoticesSchema = z.strictObject({ version: z.literal(1), sent: z.array(z.string()) });

export interface CoordinatorDispatchNotifierPorts {
  /** Open coordinator requests from the ledger. */
  list(): CoordinatorBootstrapRequest[];
  readLifecycle(): unknown;
  /** Whether the lead thread exists and is not archived; otherwise nothing is queued. */
  leadAvailable(agentId: string): Promise<boolean>;
  /** Queue the notice for the lead. The message queue delivers only while the thread is
   * idle and never unarchives it; the stable identity makes a retry enqueue at most once. */
  enqueue(input: { agentId: string; text: string; messageId: string }): Promise<void>;
  now(): number;
}

/** A deterministic UUID-shaped identity, so a retry after a lost record reuses it. */
function noticeMessageId(key: string): string {
  const hex = createHash("sha256").update(`coordinator-dispatch-notice:${key}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Tells the reviewed installation lead once about each coordinator update that failed
 * before it started or stalled after approval. A message carries no authority: it
 * never approves, cancels or relaunches anything. Notices go through the lead's message
 * queue, which waits for an idle turn, so a notice never interrupts running work.
 */
export function createCoordinatorDispatchNotifier(input: {
  agentId: string;
  stateDirectory: string;
  ports: CoordinatorDispatchNotifierPorts;
}) {
  const file = path.join(input.stateDirectory, "coordinator-dispatch-notices.json");
  const readSent = (): string[] => {
    try {
      return NoticesSchema.parse(JSON.parse(readFileSync(file, "utf8"))).sent;
    } catch {
      // A missing or unreadable record can at worst repeat a notice under the same
      // message identity; it never suppresses one.
      return [];
    }
  };
  let running = false;
  async function check(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const requests = input.ports.list();
      const now = input.ports.now();
      const statuses = coordinatorDispatchStatuses({
        requests,
        readLifecycle: input.ports.readLifecycle,
        now,
      });
      const pending: { key: string; text: string }[] = [];
      for (const request of requests) {
        const status = statuses.get(request.id);
        const inspect = `Inspect it with coordinator-status ${request.id}.`;
        if (status?.failure && now - Date.parse(status.failure.failedAt) < FAILURE_NOTICE_WINDOW_MS)
          pending.push({
            key: `${request.id}:failure:${request.revision}`,
            text: `Coordinator update ${request.id} failed before it started. ${status.failure.reason} ${inspect}`,
          });
        if (status?.stalled)
          pending.push({
            key: `${request.id}:stalled:${request.revision}`,
            text: `Coordinator update ${request.id} is approved but has not started. ${status.stalled.reason} ${inspect}`,
          });
      }
      const sent = readSent();
      // One notice per check: delivery starts a turn, so the next waits for idle again.
      const notice = pending.find((item) => !sent.includes(item.key));
      if (!notice || !(await input.ports.leadAvailable(input.agentId))) return;
      await input.ports.enqueue({
        agentId: input.agentId,
        text: notice.text,
        messageId: noticeMessageId(notice.key),
      });
      writePrivateFileAtomicSync(
        file,
        JSON.stringify({ version: 1, sent: [...sent, notice.key].slice(-RETAINED_NOTICES) }),
      );
    } finally {
      running = false;
    }
  }
  return { check };
}
