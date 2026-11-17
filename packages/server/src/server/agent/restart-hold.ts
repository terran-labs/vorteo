/**
 * A restart is holding new work while current turns finish. Retrying before the hold ends cannot
 * succeed, so callers that retry should wait for `waitForRestartHoldRelease` instead.
 */
export class RestartHoldError extends Error {
  readonly code = "restart_hold";
  constructor() {
    super(
      "A restart is waiting for current turns to finish. New work is held until restart or cancellation.",
    );
    this.name = "RestartHoldError";
  }
}

export function isRestartHoldError(error: unknown): error is RestartHoldError {
  return (error as { code?: unknown } | null)?.code === "restart_hold";
}
