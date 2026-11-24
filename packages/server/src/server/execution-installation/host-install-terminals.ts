import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedRegularFile } from "../bounded-file-read.js";

/**
 * Keeping terminals across a Host source update (#587).
 *
 * A plain Host install used to replace the launchd service with `kickstart -k`. That sends
 * SIGTERM, and SIGTERM always means "stop and close terminals", so every managed preview
 * stopped. The coordinator instead asks the running daemon to shut down keeping its
 * terminals, the same request `paseo daemon stop --keep-terminals` sends, and then starts
 * the service again. The daemon worker detaches its terminals instead of closing them, and
 * the supervisor skips its exit cleanup, so both closers keep them.
 *
 * It does so only when both releases that could start next re-link surviving services:
 * the candidate, and the previous release that a failed readiness check falls back to.
 * Otherwise a kept preview would run on under a daemon that shows it stopped, without a
 * Stop button. Anything that cannot be proven falls back to today's replacement.
 */

/** Compiled files, relative to a release root, that prove the release re-links survivors. */
const RELINK_EVIDENCE = [
  {
    file: "packages/server/dist/server/server/workspace-script-relink.js",
    // Logged by the re-link itself; see workspace-script-relink.ts.
    text: "Re-linked a workspace service that survived the daemon",
  },
  {
    file: "packages/server/dist/server/server/bootstrap.js",
    // Startup actually calls it before listening.
    text: "relinkWorkspaceScripts(",
  },
] as const;
const RELINK_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Whether the release at `release` re-links workspace services that survive a daemon
 * replacement. Reads the release's own compiled files, never a version string. Each file is
 * read with lstat first, regular files only, bounded. Any doubt answers false, which keeps
 * today's behavior: the install closes terminals.
 */
export async function releaseRelinksSurvivingServices(release: string): Promise<boolean> {
  for (const evidence of RELINK_EVIDENCE) {
    const read = await readBoundedRegularFile(
      path.join(release, evidence.file),
      RELINK_EVIDENCE_MAX_BYTES,
    );
    if (!read?.text.includes(evidence.text)) return false;
  }
  return true;
}

/**
 * Whether a Host install may keep terminals: both releases that could start next, the
 * candidate and the previous one a failed readiness check falls back to, re-link.
 */
export async function installMayKeepTerminals(
  candidate: string,
  previous: string,
): Promise<boolean> {
  return (
    (await releaseRelinksSurvivingServices(candidate)) &&
    (await releaseRelinksSurvivingServices(previous))
  );
}

/** The effects a keep-terminals replacement needs; daemon.ts supplies the real ones. */
export interface KeepTerminalsReplacement {
  /**
   * Ask the running daemon to stop and keep its terminals. Must refuse before sending when
   * the daemon does not advertise that it honors the request.
   */
  shutdownKeepingTerminals(): Promise<void>;
  /** True once the daemon that was asked to stop no longer answers as itself. */
  stopped(): Promise<boolean>;
  /** Start the service if it is not running. Never stops a running one. */
  start(): Promise<void>;
  /** Today's replacement: `launchctl kickstart -k` or `systemctl --user restart`. */
  replace(): Promise<void>;
  /** How long the daemon may take to stop. */
  stopDeadlineMs: number;
  pollMs?: number;
  now?: () => number;
}

/** Recorded in the install receipt as `terminals` and `terminalsReason`. */
export type KeepTerminalsOutcome =
  | { terminals: "kept" }
  /** Tried, did not complete; replaced the old way. */
  | { terminals: "replaced"; reason: string; requestSent: boolean }
  /** Not tried; replaced the old way, which closes terminals. */
  | { terminals: "not-attempted"; reason: string };

export const NOT_RELINKING_RELEASE =
  "the candidate or the previous release does not re-link surviving services";

/**
 * Stop the daemon keeping its terminals, then start the service. If the request fails,
 * times out or is refused, or the daemon is still running at the deadline, replace the
 * service the old way so the install still completes, and report why.
 */
export async function replaceHostKeepingTerminals(
  effects: KeepTerminalsReplacement,
): Promise<KeepTerminalsOutcome> {
  const now = effects.now ?? Date.now;
  const fallback = async (reason: string, requestSent: boolean): Promise<KeepTerminalsOutcome> => {
    await effects.replace();
    return { terminals: "replaced", reason, requestSent };
  };
  try {
    await effects.shutdownKeepingTerminals();
  } catch (error) {
    // A lost reply may still have been acted on. Either way the candidate re-links, so a
    // supervisor already stopping with its terminals kept is safe to replace now.
    return fallback(error instanceof Error ? error.message : String(error), true);
  }
  const deadline = now() + effects.stopDeadlineMs;
  while (!(await effects.stopped().catch(() => false))) {
    if (now() >= deadline)
      return fallback(
        `the daemon was still running ${Math.round(effects.stopDeadlineMs / 1000)} s after the keep-terminals shutdown`,
        true,
      );
    await delay(effects.pollMs ?? 500);
  }
  // launchd's KeepAlive or systemd's Restart=always normally starts it again on its own;
  // starting it here only shortens the wait, and is a no-op when it is already running.
  await effects.start();
  return { terminals: "kept" };
}

/** One sentence for the install receipt. */
export function describeTerminalOutcome(outcome: KeepTerminalsOutcome): string {
  if (outcome.terminals === "not-attempted") return `Terminals were closed: ${outcome.reason}.`;
  if (outcome.terminals === "kept")
    return "Terminals were kept for the new daemon, which re-links surviving services.";
  return `The keep-terminals shutdown did not complete (${outcome.reason}), so the service was replaced the old way, which closes terminals unless the daemon had already begun keeping them.`;
}
