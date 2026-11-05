import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  InstallationTypeChangeSchema,
  InstallationTypeSchema,
  ReleaseChannelSchema,
  type InstallationType,
  type ReleaseChannel,
} from "@getpaseo/protocol/installation-type";

/**
 * What the installation is for, in protected coordinator state beside live-dev.json. A missing
 * file is Stable. An unreadable one is never read as Lab, because Lab auto-approves lab
 * self-updates that rebuild and restart the coordinator and Host daemon from the live checkout.
 * The owner route serializes changes, so a compare-and-set cannot interleave.
 */
const StoredInstallationTypeSchema = z.strictObject({
  version: z.literal(1),
  type: InstallationTypeSchema,
  /** Absent in records written before release channels: Stable. */
  releaseChannel: ReleaseChannelSchema.optional(),
  changedAt: z.string().datetime(),
});

export interface InstallationTypeRecord {
  type: InstallationType;
  /** Independent of the type; every installation starts on Stable. */
  releaseChannel: ReleaseChannel;
  revision: string;
  changedAt: string | null;
}

export class InstallationTypeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationTypeStateError";
  }
}

const NO_RECORD_REVISION = "none";
/** Reported for a record that cannot be read; only a change to Stable may use it. */
export const UNREADABLE_INSTALLATION_TYPE_REVISION = "unreadable";
const UNREADABLE_DETAIL = "The installation type record is unreadable.";

export function installationTypeFile(stateDir: string): string {
  return path.join(stateDir, "installation-type.json");
}

/** Throws InstallationTypeStateError when the record exists but cannot be read. */
export async function readInstallationType(stateDir: string): Promise<InstallationTypeRecord> {
  let text: string;
  try {
    text = await readFile(installationTypeFile(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        type: "stable",
        releaseChannel: "stable",
        revision: NO_RECORD_REVISION,
        changedAt: null,
      };
    throw new InstallationTypeStateError(UNREADABLE_DETAIL);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InstallationTypeStateError(UNREADABLE_DETAIL);
  }
  const parsed = StoredInstallationTypeSchema.safeParse(value);
  if (!parsed.success) throw new InstallationTypeStateError(UNREADABLE_DETAIL);
  return {
    type: parsed.data.type,
    releaseChannel: parsed.data.releaseChannel ?? "stable",
    revision: createHash("sha256").update(text).digest("hex"),
    changedAt: parsed.data.changedAt,
  };
}

/** The type for status replies: an unreadable record reports Stable with the unreadable token. */
export async function reportedInstallationType(
  stateDir: string,
): Promise<InstallationTypeRecord & { unreadable: boolean }> {
  try {
    return { ...(await readInstallationType(stateDir)), unreadable: false };
  } catch (error) {
    if (!(error instanceof InstallationTypeStateError)) throw error;
    return {
      type: "stable",
      releaseChannel: "stable",
      revision: UNREADABLE_INSTALLATION_TYPE_REVISION,
      changedAt: null,
      unreadable: true,
    };
  }
}

/** Called only from the owner-authenticated route. A stale revision is refused. */
export async function changeInstallationType(
  stateDir: string,
  input: unknown,
  now: () => Date = () => new Date(),
): Promise<InstallationTypeRecord> {
  const change = InstallationTypeChangeSchema.parse(input);
  let current: InstallationTypeRecord;
  try {
    current = await readInstallationType(stateDir);
  } catch (error) {
    // The owner can always repair an unreadable record by choosing Stable.
    if (!(error instanceof InstallationTypeStateError) || change.type !== "stable") throw error;
    // A placeholder that makes the repair to Stable always write a fresh record.
    current = {
      type: "lab",
      releaseChannel: "stable",
      revision: UNREADABLE_INSTALLATION_TYPE_REVISION,
      changedAt: null,
    };
  }
  if (change.expectedRevision !== current.revision)
    throw new InstallationTypeStateError(
      "The installation type changed elsewhere. Refresh before saving.",
    );
  const type = change.type ?? current.type;
  const releaseChannel = change.releaseChannel ?? current.releaseChannel;
  if (type === current.type && releaseChannel === current.releaseChannel) return current;
  const temporary = path.join(stateDir, `.installation-type.json.${process.pid}.${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, type, releaseChannel, changedAt: now().toISOString() }),
      { mode: 0o600 },
    );
    await rename(temporary, installationTypeFile(stateDir));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return readInstallationType(stateDir);
}
