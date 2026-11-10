import { LiveDevChangeSchema, type LiveDevMode } from "@getpaseo/protocol/live-dev";
import {
  changeInstallationType,
  InstallationTypeStateError,
  readInstallationType,
  UNREADABLE_INSTALLATION_TYPE_REVISION,
  type InstallationTypeRecord,
} from "../installation-type.js";

/**
 * Delivery mode follows the installation type: Lab serves the live checkout, Stable serves the
 * published interface. One owner choice covers both, because a lab self-update builds from the
 * live checkout and Lab without it could not update itself. The type record lives in protected
 * coordinator state; an unreadable one is refused rather than read as Live, because live mode
 * widens what reaches the owner's browser. A `live-dev.json` from before the merge is ignored.
 */
export interface LiveDevModeRecord {
  mode: LiveDevMode;
  revision: string;
  changedAt: string | null;
}

export class LiveDevStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveDevStateError";
  }
}

/** Reported for a record that cannot be read; only a change to Reliable may use it. */
export const UNREADABLE_REVISION = UNREADABLE_INSTALLATION_TYPE_REVISION;

function fromType(record: InstallationTypeRecord): LiveDevModeRecord {
  return {
    mode: record.type === "lab" ? "live" : "reliable",
    revision: record.revision,
    changedAt: record.changedAt,
  };
}

export async function readLiveDevMode(stateDir: string): Promise<LiveDevModeRecord> {
  try {
    return fromType(await readInstallationType(stateDir));
  } catch (error) {
    if (error instanceof InstallationTypeStateError)
      throw new LiveDevStateError("The installation type record is unreadable.");
    throw error;
  }
}

/**
 * The delivery mode route from before the merge, kept for older interfaces: Live dev chooses
 * Lab and Reliable chooses Stable, with the installation type's revision. Called only from the
 * owner-authenticated route. A stale revision is refused.
 */
export async function changeLiveDevMode(
  stateDir: string,
  input: unknown,
): Promise<LiveDevModeRecord> {
  const change = LiveDevChangeSchema.parse(input);
  try {
    return fromType(
      await changeInstallationType(stateDir, {
        expectedRevision: change.expectedRevision,
        type: change.mode === "live" ? "lab" : "stable",
      }),
    );
  } catch (error) {
    if (error instanceof InstallationTypeStateError) throw new LiveDevStateError(error.message);
    throw error;
  }
}
