/**
 * Bounds overlap between query starts sharing a configuration-directory key in this process.
 * Initialization is not proof of refresh completion; later and cross-process refreshes remain
 * outside this slot. The provider age check is separate from the bounded host shutdown wait.
 */

/** Longest a start holds its account's slot before the next start may go ahead regardless. */
export const CLAUDE_START_SLOT_MAX_MS = 15_000;
/** Age veto for idle release; host shutdown has its own shorter, bounded wait. */
export const CLAUDE_PROVIDER_SETTLE_MS = 60_000;

const startTails = new Map<string, Promise<void>>();

export interface ClaudeStartSlot {
  /** Holds the slot until SDK initialization settles or the maximum hold expires. */
  releaseWhen(settled: Promise<unknown>): void;
  /** Frees the slot now, for a start that never spawned a CLI. Safe to call more than once. */
  release(): void;
}

/**
 * Waits for SDK initialization of the previous query start with the exact same key in this
 * process. Different keys do not wait. Every slot frees itself after maxHoldMs.
 */
export async function acquireClaudeStartSlot(
  account: string,
  maxHoldMs: number = CLAUDE_START_SLOT_MAX_MS,
): Promise<ClaudeStartSlot> {
  const previous = startTails.get(account) ?? Promise.resolve();
  let free!: () => void;
  const freed = new Promise<void>((resolve) => {
    free = resolve;
  });
  const tail = previous.then(() => freed);
  startTails.set(account, tail);
  void tail.finally(() => {
    if (startTails.get(account) === tail) startTails.delete(account);
  });
  await previous;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    free();
  };
  const timer = setTimeout(release, maxHoldMs);
  timer.unref?.();
  return {
    releaseWhen(settled) {
      void settled.catch(() => undefined).finally(release);
    },
    release,
  };
}

/** True while a CLI started at startedAt is younger than settleMs and may still be refreshing. */
export function claudeProviderSettling(
  startedAt: number | null,
  now: number = Date.now(),
  settleMs: number = CLAUDE_PROVIDER_SETTLE_MS,
): boolean {
  return startedAt !== null && now - startedAt < settleMs;
}

/** Legacy opt-in filename. Debug output remains unavailable even when this file requests it. */
export const CLAUDE_DEBUG_LOGS_SETTINGS_FILE = "claude-debug-logs.json";

/**
 * Returning a pathname cannot establish private custody when the SDK opens it later. Debug
 * output stays unavailable until that boundary and credential exclusion are established.
 */
export async function claudeDebugLogFile(_input: {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<string | null> {
  return null;
}
