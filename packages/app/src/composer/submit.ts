import { i18n } from "@/i18n/i18next";
import { isConnectionError, toErrorMessage } from "@/utils/error-messages";

export type AgentInputSubmitResult = "noop" | "queued" | "submitted" | "failed";

export interface AgentInputSubmitActionInput<TAttachment> {
  message: string;
  attachments: TAttachment[];
  hasExternalContent?: boolean;
  allowEmptySubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  forceSend?: boolean;
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: { message: string; attachments: TAttachment[] }) => void | Promise<void>;
  submitMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void>;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: TAttachment[]) => void;
  /** Reads what the user typed while the submit was in flight, so a failure keeps it. */
  getUserInput?: () => string;
  getAttachments?: () => TAttachment[];
  setSendError: (message: string | null) => void;
  /** Reports a send that failed because the connection dropped; it leaves no inline error. */
  reportConnectionError: (error: unknown) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
  failedToSendMessage?: string;
}

export async function submitAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const attachments = input.attachments;
  const shouldClearOnSubmit = input.submitBehavior !== "preserve-and-lock";

  if (
    !trimmedMessage &&
    attachments.length === 0 &&
    !input.hasExternalContent &&
    !input.allowEmptySubmit
  ) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  if (input.isAgentRunning && !input.forceSend) {
    return queueAgentInput(input, trimmedMessage);
  }

  // Clear immediately so the submitted timeline row and composer state stay in sync.
  if (shouldClearOnSubmit) {
    input.setUserInput("");
    input.setAttachments([]);
  }
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({ message: trimmedMessage, attachments });
    input.clearDraft("sent");
    input.setIsProcessing(false);
    return "submitted";
  } catch (error) {
    input.onSubmitError?.(error);
    if (shouldClearOnSubmit) {
      // The composer was cleared on submit, so anything in it now is a newer draft. Put the
      // failed message back above it instead of replacing it.
      const draft = input.getUserInput?.() ?? "";
      input.setUserInput(
        draft.trim() && trimmedMessage ? `${trimmedMessage}\n\n${draft}` : trimmedMessage || draft,
      );
      input.setAttachments([...attachments, ...(input.getAttachments?.() ?? [])]);
    }
    reportSendFailure(input, error);
    input.setIsProcessing(false);
    return "failed";
  }
}

async function queueAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  message: string,
): Promise<AgentInputSubmitResult> {
  input.setSendError(null);
  input.setIsProcessing(true);
  try {
    await input.queueMessage({ message, attachments: input.attachments });
    if (input.submitBehavior !== "preserve-and-lock") {
      input.setUserInput("");
      input.setAttachments([]);
    }
    return "queued";
  } catch (error) {
    input.onSubmitError?.(error);
    reportSendFailure(input, error);
    return "failed";
  } finally {
    input.setIsProcessing(false);
  }
}

// A dropped connection is transient, so it becomes a toast while the restored draft waits for
// a retry. The send action wraps an ambiguous drop in its own message with the transport error
// as the cause. Host rejections stay inline until the user edits the draft or reconnects.
function reportSendFailure<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  error: unknown,
): void {
  const isDroppedConnection =
    isConnectionError(error) || (error instanceof Error && isConnectionError(error.cause));
  if (isDroppedConnection) {
    input.reportConnectionError(error);
    return;
  }
  input.setSendError(
    error instanceof Error
      ? toErrorMessage(error)
      : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
  );
}

/**
 * Whether a send error is the daemon's restart-hold refusal. STOPGAP (#720): the send response
 * does not carry the error code yet, so this matches the daemon's RestartHoldError text; switch
 * to `errorCode === "restart_hold"` once the response carries it.
 */
export function isRestartHoldRefusal(message: string): boolean {
  return message.startsWith("A restart is waiting for current turns to finish.");
}

/**
 * What the composer tells the owner about a send (#720), so the three outcomes never look alike:
 * queued (accepted; it is sent when the running turn finishes), held (not sent; a tracked restart
 * hold refused it and the draft is kept) and failed (not sent, with its own reason).
 */
export type SendNotice = "queued" | "held" | "failed" | null;

export function sendNotice(input: {
  result: AgentInputSubmitResult | null;
  error: string | null;
  /** A tracked restart or update hold is active for this thread's daemon. */
  holdActive: boolean;
}): SendNotice {
  if (input.error) {
    return input.holdActive && isRestartHoldRefusal(input.error) ? "held" : "failed";
  }
  return input.result === "queued" ? "queued" : null;
}

/** How long the queued confirmation stays under the composer. */
export const QUEUED_NOTICE_MS = 6_000;

/**
 * Milliseconds the queued confirmation still has to show, measured from the queueing itself, so
 * a remount can never revive an expired or older confirmation. Zero means do not show it.
 */
export function queuedNoticeRemainingMs(queuedAt: number | null, now: number): number {
  if (queuedAt === null) return 0;
  return Math.max(0, queuedAt + QUEUED_NOTICE_MS - now);
}
