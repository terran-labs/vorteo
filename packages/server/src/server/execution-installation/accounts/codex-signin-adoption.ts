import { z } from "zod";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { CodexAdoptionRetention, InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import {
  CodexLegacyInspectResponseSchema,
  CodexLegacySessionCheckResponseSchema,
  CodexLegacySessionsResponseSchema,
  type CodexLegacyBusy,
  CodexLegacyTargetSchema,
  CodexSignInDeliveryError,
  CodexSignInRefused,
  type CodexLegacyTarget,
} from "./codex-signin-delivery.js";
import { verifyCodexHostSession, type CodexHostGrant } from "./codex-signin-host.js";
import { codexSessionCheck, codexSignInKeyDigest } from "./codex-signin-identity.js";
import type { CodexSignInRefresher } from "./codex-signin-refresher.js";

/**
 * Adoption in place of a legacy Codex definition (an `accountId`, no `accountSetup`) whose Host
 * binding is already a managed Host account. Dev keeps its legacy binding, CODEX_HOME and thread
 * history; the coordinator projects the Host's access-only grant into that home's `auth.json`.
 * Nothing in shared settings changes, so "adopted" exists only in this coordinator record.
 *
 * Only the owner starts an adoption, one at a time. Every step fails closed before anything is
 * written, and nothing here ever signs the Host out.
 */

const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const DAY_MS = 24 * 60 * 60_000;
/** Saved copies one account may have on Dev at once, each in its own folder. */
const MAX_COPIES = 8;

export const CodexAdoptionStatusSchema = z.enum([
  "verifying-host",
  "pinning",
  "projecting",
  "adopted",
  "failed",
  "cancelled",
  "needs-owner-confirmation",
  "unadopting",
  "unadopted",
]);
export type CodexAdoptionStatus = z.infer<typeof CodexAdoptionStatusSchema>;

/**
 * A pinned Dev home as stored. Its real path is its identity; the device and inode Dev reported
 * are kept for older Dev daemons, which still compare them.
 */
const StoredTargetSchema = z.looseObject({
  realpath: CodexLegacyTargetSchema.shape.realpath,
  dev: CodexLegacyTargetSchema.shape.dev,
  ino: CodexLegacyTargetSchema.shape.ino,
});
type StoredTarget = z.infer<typeof StoredTargetSchema>;

const CopySchema = z.looseObject({
  target: StoredTargetSchema,
  savedSince: Counter,
  /**
   * The person first projected into this folder, whose sign-in its copy saved. Kept in the
   * sidecar, never in `adoption.json`; see AdoptionExtraSchema.
   */
  person: Digest.optional(),
});
type SavedCopy = z.infer<typeof CopySchema>;

/** The states a record pauses from when Dev refuses a changed folder; it resumes only to one. */
const ParkedFromSchema = z.enum(["projecting", "adopted", "unadopting"]);
type ParkedFrom = z.infer<typeof ParkedFromSchema>;

/**
 * Secret-free: identifiers, a directory pin and times. No account ID, email or token. Read
 * leniently and written back whole: fields from a newer coordinator survive a downgrade and
 * upgrade, and every field added after the first release is optional.
 */
const AdoptionRecordSchema = z.looseObject({
  definitionId: z.string().min(1),
  status: CodexAdoptionStatusSchema,
  devServerId: z.string().min(1),
  /** Dev's binding as it is in settings. A different binding later cancels the adoption. */
  devProviderId: z.string().min(1),
  hostProviderId: z.string().min(1),
  target: StoredTargetSchema.nullable(),
  startedAt: Counter,
  /** First projection Dev acknowledged. Retention's cap counts from here. */
  projectedAt: Counter.nullable(),
  /** Host access expiry at projectedAt; a later acknowledged expiry means a Host refresh. */
  projectedExpiresAt: Counter.nullable(),
  renewedAt: Counter.nullable(),
  /** A Dev usage read without a sign-in rejection after the first Host refresh. */
  provenAt: Counter.nullable(),
  copyForgottenAt: Counter.nullable(),
  /** Last time Dev had written its own sign-in over the projection and it was replaced. */
  replacedLocallyAt: Counter.nullable(),
  /** If the Host later needs sign-in, the installation's Host sign-in repairs Dev as well. */
  fallback: z.literal("host-sign-in"),
  /** After un-adopt: the restored local sign-in was not tested and may need a new sign-in. */
  restored: z.looseObject({ copyAgeMs: Counter, mayNeedSignIn: z.literal(true) }).nullable(),
  /**
   * Un-adopted from a cancelled, failed or confirmation-pending record: nothing was withdrawn or
   * put back, so whatever is in Dev's home stays as it is. The app says so plainly.
   */
  restoreSkipped: z.literal(true).optional(),
  /**
   * Every pinned Dev directory this account was projected into whose saved copy may still exist,
   * one per real path, each with its own clock. Carried across records, so a re-switch into
   * another directory, a failed retry or a refusal never drops one, and each copy is deleted at
   * its own cap.
   */
  copies: z.array(CopySchema).max(MAX_COPIES).optional(),
  /** The person whose projection Dev's home holds, from Dev's first acknowledgement of it. */
  heldIdentityDigest: Digest.nullable().optional(),
  /**
   * The person this record must find on the Host, carried from an earlier record whose Dev home
   * may still hold that person's projection. A different person waits for the owner.
   */
  expectedIdentityDigest: Digest.nullable().optional(),
  /** The different person found on the Host, which the owner's confirmation accepts. */
  pendingIdentityDigest: Digest.nullable().optional(),
  /** Past the retention cap, the plain reason the saved copy on Dev could not be deleted. */
  copyDeleteBlocked: z.string().max(300).nullable().optional(),
  /**
   * SHA-256 of the workspace and person the Host was signed in as when the owner set this up.
   * Every projection must match it; a different person waits for the owner. Never raw IDs.
   */
  hostIdentityDigest: Digest.nullable().optional(),
  /**
   * Why a record waits for the owner: `target_changed` or `identity_changed`. A string, so a
   * reason a newer coordinator adds keeps the record readable. Only a changed folder resumes by
   * itself; see resumesTo(). Sidecar only.
   */
  parkedReason: z.string().max(64).optional(),
  /** The status a folder change paused, the only one it may resume to. Sidecar only. */
  parkedFrom: ParkedFromSchema.optional(),
  error: z.string().max(300).nullable(),
});
export type CodexAdoptionRecord = z.infer<typeof AdoptionRecordSchema>;

/**
 * Facts this coordinator keeps beside `adoption.json`, in `adoption-extra.json` keyed by
 * definition ID, so every record in `adoption.json` stays in the shape the first adoption
 * release reads strictly and a rolled-back coordinator still reads it. A missing or unreadable
 * entry means no extra facts: nothing resumes by itself, and restores check the copy's own
 * contents.
 */
const AdoptionExtraSchema = z.looseObject({
  /** The record these parked facts were written with; they apply to no other. */
  startedAt: Counter,
  status: z.string().max(64),
  parkedReason: z.string().max(64).optional(),
  parkedFrom: z.string().max(64).optional(),
  /** Each copy's person, matched by real path and clock. */
  persons: z
    .array(z.looseObject({ realpath: z.string(), savedSince: Counter, person: Digest }))
    .max(MAX_COPIES)
    .optional(),
});
type AdoptionExtra = z.infer<typeof AdoptionExtraSchema>;
const AdoptionExtrasSchema = z.record(z.string(), z.unknown());

/** The record without its sidecar facts, as `adoption.json` keeps it. */
function storedShape(record: CodexAdoptionRecord): unknown {
  const { parkedReason: _reason, parkedFrom: _from, copies, ...rest } = record;
  if (!copies) return rest;
  return { ...rest, copies: copies.map(({ person: _person, ...copy }) => copy) };
}

function extraOf(record: CodexAdoptionRecord): AdoptionExtra | null {
  const persons = (record.copies ?? []).flatMap((copy) =>
    copy.person
      ? [{ realpath: copy.target.realpath, savedSince: copy.savedSince, person: copy.person }]
      : [],
  );
  if (record.parkedReason === undefined && record.parkedFrom === undefined && !persons.length)
    return null;
  return {
    startedAt: record.startedAt,
    status: record.status,
    ...(record.parkedReason !== undefined ? { parkedReason: record.parkedReason } : {}),
    ...(record.parkedFrom !== undefined ? { parkedFrom: record.parkedFrom } : {}),
    ...(persons.length ? { persons } : {}),
  };
}

/** The record with its sidecar facts. Anything inline in `adoption.json` is ignored. */
function withExtra(record: CodexAdoptionRecord, raw: unknown): CodexAdoptionRecord {
  const { parkedReason: _reason, parkedFrom: _from, copies, ...rest } = record;
  const extra = AdoptionExtraSchema.safeParse(raw).data;
  const current = extra?.startedAt === record.startedAt && extra.status === record.status;
  const parkedFrom = ParkedFromSchema.safeParse(extra?.parkedFrom).data;
  const withPersons = copies?.map(({ person: _person, ...copy }) => {
    const found = extra?.persons?.find(
      (item) => item.realpath === copy.target.realpath && item.savedSince === copy.savedSince,
    );
    return Object.assign(copy, found ? { person: found.person } : {});
  });
  return {
    ...rest,
    ...(withPersons ? { copies: withPersons } : {}),
    ...(current && extra.parkedReason !== undefined ? { parkedReason: extra.parkedReason } : {}),
    ...(current && parkedFrom ? { parkedFrom } : {}),
  };
}

/** Just enough of a record that does not parse to keep honouring it. */
const RecordOwnerSchema = z.object({ definitionId: z.string().min(1) });
const RecordFolderSchema = z.object({ target: z.object({ realpath: z.string().startsWith("/") }) });

/** A stored record this coordinator cannot read: kept verbatim and never delivered to. */
interface UnreadableRecord {
  raw: unknown;
  definitionId: string | null;
  realpath: string | null;
}

interface LoadedJournal {
  records: CodexAdoptionRecord[];
  unreadable: UnreadableRecord[];
  /** False when the file itself is unreadable, so nothing may be written over it. */
  intact: boolean;
}

/**
 * Whether a record waits only because Dev refused a changed folder. A different person never
 * counts, whatever else holds.
 */
function folderChange(record: CodexAdoptionRecord): boolean {
  if (
    record.status !== "needs-owner-confirmation" ||
    record.target === null ||
    record.pendingIdentityDigest ||
    record.error === IDENTITY_CHANGED
  )
    return false;
  // COMPAT(codexLegacyPinByPath): added after 26.11.2100, remove after 2027-05-25. The first
  // adoption release parked a changed folder with this exact text and no reason. It counts for
  // the owner's actions only, never for resuming by itself.
  const legacyFolderChange = record.parkedReason === undefined && record.error === TARGET_CHANGED;
  return record.parkedReason === "target_changed" || legacyFolderChange;
}

/**
 * A folder change paused with no record of which way it was going: a switch or an undo. The
 * owner then chooses explicitly between switching and stopping.
 */
export function adoptionDirectionUnknown(record: CodexAdoptionRecord): boolean {
  return folderChange(record) && record.parkedFrom === undefined;
}

const IN_PROGRESS: ReadonlySet<CodexAdoptionStatus> = new Set([
  "verifying-host",
  "pinning",
  "projecting",
  "unadopting",
]);
/** The refresher projects into the legacy home only in these states. */
const DELIVERING: ReadonlySet<CodexAdoptionStatus> = new Set([
  "projecting",
  "adopted",
  "unadopting",
]);
/** Records the tick no longer steps, though retention still applies to them. */
const OUTSIDE_DELIVERY: ReadonlySet<CodexAdoptionStatus> = new Set([
  "failed",
  "unadopted",
  "cancelled",
]);
/** The same folder: a real path. Device and inode taken at different times can drift apart. */
function sameTarget(a: StoredTarget, b: StoredTarget): boolean {
  return a.realpath === b.realpath;
}

/** The target as Dev's strict schema accepts it, without fields only this record keeps. */
export function wireTarget(target: StoredTarget): CodexLegacyTarget {
  return { realpath: target.realpath, dev: target.dev, ino: target.ino };
}

/**
 * Adds a folder's copy once. Entries for the same real path merge and keep the earliest clock,
 * so a recreated or drifted folder never restarts it.
 */
function withCopy(
  copies: SavedCopy[] | undefined,
  copy: { target: StoredTarget; savedSince: number; person: string },
): SavedCopy[] {
  const list = copies ?? [];
  const same = list.filter((item) => sameTarget(item.target, copy.target));
  if (same.length === 0) return [...list, copy];
  const savedSince = Math.min(...same.map((item) => item.savedSince));
  const others = list.filter((item) => !sameTarget(item.target, copy.target));
  return [...others, { ...same[0]!, savedSince }];
}

/** Retention retries for records outside delivery wait this long after a failed attempt. */
const RETENTION_RETRY_MS = 60 * 60_000;
/** A paused record that could not resume tries again after this long. */
const RESUME_RETRY_MS = 5 * 60_000;

/** Records that hold a Dev home; two of them may never share one directory. */
const HOLDING: ReadonlySet<CodexAdoptionStatus> = new Set([
  "pinning",
  "projecting",
  "adopted",
  "needs-owner-confirmation",
  "unadopting",
]);

export const IDENTITY_CHANGED =
  "The Host is now signed in as a different person than when this was set up. Confirm to use the new sign-in on Dev, or sign the Host in again as the original account. If you confirm, stopping later still puts back the original Dev sign-in.";

export const ACTIVE_DEV_SESSION = "A Dev session is using this account. Stop it, then try again.";

/** Stored on the record; the owner's reply names the threads, which are never stored. */
export const SAME_GRANT_BUSY =
  "Dev is using the same sign-in as the Host on this account, and a Dev thread is running. Try again when it has finished.";

/** The owner's reply for SAME_GRANT_BUSY, with the busy threads' plain titles. */
export function sameGrantBusyMessage(busy: CodexLegacyBusy): string {
  const quoted = busy.titles.map((title) => `"${title}"`).join(", ");
  const titles = busy.more > 0 ? `${quoted} and ${busy.more} more` : quoted;
  return `Dev is using the same sign-in as the Host on this account, and a Dev thread is running: ${titles}. Try again when it has finished.`;
}

export const STOPPING = "This account is being stopped. It finishes by itself in a few minutes.";

/** Set by refused(); an earlier release parked with this same text and no reason. */
const TARGET_CHANGED = "Dev's folder for this account changed. Confirm to try again.";

export const TOO_MANY_FOLDERS =
  "This account has sign-in backups in other Dev folders that have not been deleted yet. Try again once they are; each is deleted within 30 days.";

/** A refusal whose fixed text the owner's routes pass on as it is. */
export class CodexAdoptionRefusal extends Error {}

export class CodexAdoptionBusy extends CodexAdoptionRefusal {
  constructor() {
    super("Another Codex account is switching to the Host's sign-in. Wait for it to finish.");
  }
}

export const UNREADABLE_RECORD =
  "This account's saved switch record could not be read, so nothing is changed. Update Vorteo, or ask for help if this stays.";

export const OTHER_UNREADABLE_RECORD =
  "Another account's saved switch record could not be read, so nothing is changed. Update Vorteo, or ask for help if this stays.";

/** An undo Dev paused for a changed folder finishes by itself; a switch would reverse it. */
export class CodexAdoptionStopping extends CodexAdoptionRefusal {
  constructor() {
    super(STOPPING);
  }
}

/** Carries UNREADABLE_RECORD or OTHER_UNREADABLE_RECORD. */
export class CodexAdoptionUnreadable extends CodexAdoptionRefusal {}

/** A step that cannot succeed as things stand. Its message is the plain reason shown later. */
class AdoptionRefused extends Error {}

/** Dev runs a thread on the Host's own grant. Only the owner's reply carries the titles. */
class SameGrantBusy extends AdoptionRefused {
  constructor(readonly ownerMessage: string) {
    super(SAME_GRANT_BUSY);
  }
}

/**
 * The stored records and their sidecar, unvalidated: adoption reads them one by one. The reads
 * may throw.
 */
export interface CodexAdoptionJournal {
  read(): unknown;
  write(records: unknown[]): void;
  readExtra(): unknown;
  writeExtra(extras: Record<string, unknown>): void;
}

/** What the coordinator needs from Dev's usage read for an adopted binding. */
export interface DevUsageObservation {
  status: "available" | "unavailable" | "error";
  fetchedAt: string | null;
  authRecovery: boolean;
}

export interface CodexAdoptionDeps {
  config: Pick<InstallationConfig, "public">;
  settings: Pick<InstallationSettingsService, "snapshot">;
  journal: CodexAdoptionJournal;
  refresher: Pick<
    CodexSignInRefresher,
    "connected" | "signedOut" | "retire" | "withdrawn" | "reconcile" | "recover" | "status"
  >;
  /** Throws when a daemon is unreachable; false when one lacks a required capability. */
  supported(): Promise<boolean>;
  /** Whether Dev advertises `codexLegacyPinByPath`. Throws when Dev is unreachable. */
  pinByPath(): Promise<boolean>;
  /** Whether Dev advertises `codexLegacySessionHold`. Throws when Dev is unreachable. */
  sessionHold(): Promise<boolean>;
  /** The Host binding's exact CODEX_HOME through the legacy binding route. */
  hostHome(definitionId: string, hostProviderId: string, revision: number): Promise<string>;
  /** Dev's legacy route. Throws CodexSignInRefused when Dev answers with a refusal. */
  dev(body: Record<string, unknown>): Promise<unknown>;
  /** Reads the Host file only. Adoption never starts Codex. */
  readGrant(codexHome: string): CodexHostGrant | null;
  devUsage(providerId: string): Promise<DevUsageObservation | null>;
  retention(definitionId: string): CodexAdoptionRetention;
  now(): number;
}

const MANAGED_PROVIDER_ID =
  /^codex-account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Dev binding and policy facts adoption depends on, from current settings. */
function legacyFacts(definition: InstallationProvider | undefined, devServerId: string) {
  return {
    devProviderId: definition?.bindings[devServerId],
    legacy:
      definition !== undefined &&
      definition.providerType === "codex" &&
      definition.accountSetup === undefined &&
      definition.removed !== true,
  };
}

export function createCodexAdoption(deps: CodexAdoptionDeps) {
  const host = deps.config.public.environments.find((item) => item.kind === "host")!;
  const containers = deps.config.public.environments.filter((item) => item.kind === "container");
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const task = queue.then(operation);
    queue = task.catch(() => undefined);
    return task;
  }

  /** Parses record by record, so one unreadable record never stops the others. Never throws. */
  function load(): LoadedJournal {
    let raw: unknown;
    try {
      raw = deps.journal.read();
    } catch {
      raw = undefined;
    }
    if (!Array.isArray(raw))
      return {
        records: [],
        unreadable: [{ raw, definitionId: null, realpath: null }],
        intact: false,
      };
    const extras = readExtras();
    const records: CodexAdoptionRecord[] = [];
    const unreadable: UnreadableRecord[] = [];
    for (const item of raw) {
      const parsed = AdoptionRecordSchema.safeParse(item);
      if (parsed.success)
        records.push(withExtra(parsed.data, extras[parsed.data.definitionId] ?? null));
      else
        unreadable.push({
          raw: item,
          definitionId: RecordOwnerSchema.safeParse(item).data?.definitionId ?? null,
          realpath: RecordFolderSchema.safeParse(item).data?.target.realpath ?? null,
        });
    }
    return { records, unreadable, intact: true };
  }

  /** Every sidecar entry, unvalidated. An unreadable sidecar holds no facts. */
  function readExtras(): Record<string, unknown> {
    try {
      return AdoptionExtrasSchema.safeParse(deps.journal.readExtra()).data ?? {};
    } catch {
      return {};
    }
  }

  function find(definitionId: string): CodexAdoptionRecord | undefined {
    return load().records.find((item) => item.definitionId === definitionId);
  }

  /**
   * The sidecar first: a crash before `adoption.json` is written leaves facts whose record no
   * longer matches, which are ignored.
   */
  function save(record: CodexAdoptionRecord): CodexAdoptionRecord {
    const journal = load();
    if (!journal.intact) throw new CodexAdoptionUnreadable(UNREADABLE_RECORD);
    const { [record.definitionId]: _previous, ...extras } = readExtras();
    const extra = extraOf(record);
    deps.journal.writeExtra(extra ? { ...extras, [record.definitionId]: extra } : extras);
    deps.journal.write([
      ...journal.unreadable.map((item) => item.raw),
      ...journal.records
        .filter((item) => item.definitionId !== record.definitionId)
        .map(storedShape),
      storedShape(record),
    ]);
    return record;
  }

  /**
   * The fixed reason an unreadable record stops this definition, or null: its own record, the
   * whole file, or another record whose folder is unknown and so could be any folder. Un-adopt
   * checks only the definition's own record and the whole file.
   */
  function unreadableFor(
    definitionId: string,
    operation: "adopt" | "unadopt",
  ): typeof UNREADABLE_RECORD | typeof OTHER_UNREADABLE_RECORD | null {
    const journal = load();
    if (!journal.intact) return UNREADABLE_RECORD;
    if (journal.unreadable.some((item) => item.definitionId === definitionId))
      return UNREADABLE_RECORD;
    const unknownFolder = journal.unreadable.some((item) => item.realpath === null);
    return operation === "adopt" && unknownFolder ? OTHER_UNREADABLE_RECORD : null;
  }

  function selected(definitionId: string) {
    const snapshot = deps.settings.snapshot();
    const definition = snapshot.settings?.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    return { snapshot, definition };
  }

  function excludedOnDev(definition: InstallationProvider, devServerId: string): boolean {
    const exclusions = deps.settings.snapshot().settings?.resourceExclusions[devServerId];
    return (
      definition.removed === true ||
      definition.policy.enabled === false ||
      exclusions?.providerIds?.includes(definition.id) === true
    );
  }

  /** The bindings adoption keeps, or the plain reason the definition does not qualify. */
  function eligibility(definitionId: string) {
    const { snapshot, definition } = selected(definitionId);
    if (!definition || definition.providerType !== "codex") throw new CodexSignInDeliveryError();
    const dev = containers.length === 1 ? containers[0]! : null;
    const hostProviderId = definition.bindings[host.serverId];
    const devProviderId = dev ? definition.bindings[dev.serverId] : undefined;
    const binding = {
      devServerId: dev?.serverId ?? "",
      devProviderId: devProviderId ?? "",
      hostProviderId: hostProviderId ?? "",
    };
    let reason: string | null = null;
    if (snapshot.conflicts)
      reason = "The Host and Dev settings conflict. Resolve the conflict, then try again.";
    else if (definition.removed) reason = "This account was removed.";
    else if (definition.accountSetup) reason = "This account already uses the Host's sign-in.";
    else if (!definition.accountId)
      reason =
        "This account is not linked between the Host and Dev, so it cannot use the Host's sign-in.";
    else if (!hostProviderId || !MANAGED_PROVIDER_ID.test(hostProviderId))
      reason =
        "The Host keeps this account's sign-in outside the installation, so Dev cannot share it.";
    else if (!dev) reason = "This installation has no Dev environment.";
    else if (!devProviderId) reason = "Dev does not have this account set up.";
    else if (excludedOnDev(definition, dev.serverId))
      reason = "This account is turned off for Dev. Turn it on for Dev, then try again.";
    return { binding, reason, revision: snapshot.revision };
  }

  function fresh(definitionId: string, binding: ReturnType<typeof eligibility>["binding"]) {
    return {
      definitionId,
      ...binding,
      target: null,
      startedAt: deps.now(),
      projectedAt: null,
      projectedExpiresAt: null,
      renewedAt: null,
      provenAt: null,
      copyForgottenAt: null,
      replacedLocallyAt: null,
      fallback: "host-sign-in" as const,
      restored: null,
      error: null,
    };
  }

  /** The Host account's sign-in, judged from its file alone. */
  async function verifyHost(record: CodexAdoptionRecord, revision: number) {
    let home: string;
    try {
      home = await deps.hostHome(record.definitionId, record.hostProviderId, revision);
    } catch (error) {
      if (error instanceof CodexSignInRefused)
        throw new AdoptionRefused(
          "The Host's setup for this account changed. Refresh and try again.",
        );
      throw error;
    }
    const grant = deps.readGrant(home);
    const check = verifyCodexHostSession(grant, deps.now());
    if (!check.verified) throw new AdoptionRefused(check.reason);
    // Verification already required both a workspace and a person.
    const digest = codexSignInKeyDigest(grant!.accountId, grant!.idToken);
    if (!digest) throw new AdoptionRefused(IDENTITY_CHANGED);
    return { identity: check.identity, digest };
  }

  function scope(record: CodexAdoptionRecord) {
    return {
      installationId: deps.config.public.installationId,
      serverId: record.devServerId,
      definitionId: record.definitionId,
      providerId: record.devProviderId,
      policyRevision: deps.settings.snapshot().revision,
    };
  }

  async function devRequest(body: Record<string, unknown>, refusal: string) {
    try {
      return await deps.dev(body);
    } catch (error) {
      if (error instanceof CodexSignInRefused) throw new AdoptionRefused(refusal);
      throw error;
    }
  }

  /**
   * Why Dev's use of the account stops the Host's sign-in from being written there, or null, as
   * an early refusal the owner can act on. The rule stands in for one risk: Dev holding a copy,
   * current or stale, of the Host's grant, which a Dev refresh would rotate or reuse. A Dev with
   * `codexLegacySessionHold` is asked with the Host's login-session fingerprints under a new
   * nonce: a sign-in from another login session, or none, never waits; otherwise a thread that
   * starts or runs a turn waits, and the owner is told which. Dev decides again inside the write.
   * An older Dev keeps refusing while any session on the account is loaded.
   */
  async function devUse(record: CodexAdoptionRecord): Promise<AdoptionRefused | null> {
    if (!(await deps.sessionHold())) {
      const { active } = CodexLegacySessionsResponseSchema.parse(
        await deps.dev({ ...scope(record), operation: "sessions" }),
      );
      return active ? new AdoptionRefused(ACTIVE_DEV_SESSION) : null;
    }
    const revision = deps.settings.snapshot().revision;
    const home = await deps.hostHome(record.definitionId, record.hostProviderId, revision);
    const sessionCheck = codexSessionCheck(deps.readGrant(home)?.idToken);
    const answer = CodexLegacySessionCheckResponseSchema.parse(
      await deps.dev({
        ...scope(record),
        operation: "session-check",
        ...(sessionCheck ? { sessionCheck } : {}),
      }),
    );
    if (answer.different || !answer.active) return null;
    return new SameGrantBusy(sameGrantBusyMessage(answer));
  }

  /**
   * Verify the Host, then Dev's session state and home, then start projecting. `confirmedFolder` is
   * the folder the owner confirmed after a folder change whose projection Dev already held; only
   * Dev's session check is skipped, and only while the pin still finds that folder.
   */
  async function start(
    record: CodexAdoptionRecord,
    confirmedFolder?: string,
  ): Promise<CodexAdoptionRecord> {
    const check = eligibility(record.definitionId);
    if (check.reason) throw new AdoptionRefused(check.reason);
    if (!(await deps.supported()))
      throw new AdoptionRefused("Update the Host and Dev to the latest version, then try again.");
    const hostIdentityDigest = (await verifyHost(record, check.revision)).digest;
    // A person other than the one Dev's home may still hold needs the owner's explicit say.
    const accepted = [record.expectedIdentityDigest, record.heldIdentityDigest].filter(
      (digest): digest is string => Boolean(digest),
    );
    if (accepted.length > 0 && !accepted.includes(hostIdentityDigest))
      return save({
        ...record,
        status: "needs-owner-confirmation",
        error: IDENTITY_CHANGED,
        parkedReason: "identity_changed",
        pendingIdentityDigest: hostIdentityDigest,
      });
    const pinning = save({ ...record, status: "pinning", hostIdentityDigest });
    async function assertDevIdle() {
      let refusal: AdoptionRefused | null;
      try {
        refusal = await devUse(pinning);
      } catch (error) {
        if (error instanceof CodexSignInRefused)
          throw new AdoptionRefused(
            "Dev did not accept this account's setup. Refresh and try again.",
          );
        throw error;
      }
      if (refusal) throw refusal;
    }
    if (confirmedFolder === undefined) await assertDevIdle();
    const { target } = z
      .strictObject({ target: CodexLegacyTargetSchema })
      .parse(
        await devRequest(
          { ...scope(pinning), operation: "pin" },
          "Dev's folder for this account cannot safely receive the Host's sign-in. Nothing was changed.",
        ),
      );
    if (sharesDirectory(record.definitionId, target))
      throw new AdoptionRefused(
        "Another account already uses this account's Dev folder. Nothing was changed.",
      );
    if (confirmedFolder !== undefined && target.realpath !== confirmedFolder) await assertDevIdle();
    const copies = withCopy(pinning.copies, {
      target,
      savedSince: deps.now(),
      person: hostIdentityDigest,
    });
    if (copies.length > MAX_COPIES) throw new AdoptionRefused(TOO_MANY_FOLDERS);
    // Read once more: the Host file may have changed while Dev answered.
    const { identity, digest } = await verifyHost(pinning, deps.settings.snapshot().revision);
    if (digest !== hostIdentityDigest) throw new AdoptionRefused(IDENTITY_CHANGED);
    // The person Dev's home holds changes only once Dev acknowledges the projection.
    const projecting = save({ ...pinning, status: "projecting", target, copies });
    await deps.refresher.connected(record.definitionId, identity);
    return projecting;
  }

  /**
   * Whether another record holds this folder, by real path: device and inode stored at different
   * times can match by chance on virtiofs. An unreadable record counts whatever its state.
   */
  function sharesDirectory(definitionId: string, target: StoredTarget): boolean {
    const journal = load();
    const held = journal.records.some(
      (other) =>
        other.definitionId !== definitionId &&
        HOLDING.has(other.status) &&
        other.target !== null &&
        sameTarget(other.target, target),
    );
    return (
      held ||
      journal.unreadable.some(
        (other) => other.definitionId !== definitionId && other.realpath === target.realpath,
      )
    );
  }

  /** Whether settings still bind the account exactly as it was adopted. */
  function stillBound(record: CodexAdoptionRecord): boolean {
    const { definition } = selected(record.definitionId);
    const facts = legacyFacts(definition, record.devServerId);
    return (
      facts.legacy &&
      facts.devProviderId === record.devProviderId &&
      definition?.bindings[host.serverId] === record.hostProviderId
    );
  }

  async function advanceProjecting(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
    const { definition } = selected(record.definitionId);
    if (definition && excludedOnDev(definition, record.devServerId))
      return save({
        ...record,
        status: "unadopting",
        error: "This account was turned off for Dev while switching, so the switch was undone.",
      });
    const status = deps.refresher.status(record.definitionId);
    const ready =
      status.signedIn &&
      status.environments.length > 0 &&
      status.environments.every((environment) => environment.status === "ready");
    if (!ready) return record;
    return save({
      ...record,
      status: "adopted",
      projectedAt: deps.now(),
      projectedExpiresAt: status.expiresAt,
      heldIdentityDigest: record.hostIdentityDigest ?? record.heldIdentityDigest,
    });
  }

  /** Records the first Host refresh Dev acknowledged, then Dev's own usage read after it. */
  async function trackProof(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
    if (record.provenAt !== null) return record;
    const status = deps.refresher.status(record.definitionId);
    const ready = status.environments.every((environment) => environment.status === "ready");
    let next = record;
    if (
      next.renewedAt === null &&
      ready &&
      status.expiresAt !== null &&
      next.projectedExpiresAt !== null &&
      status.expiresAt > next.projectedExpiresAt
    )
      next = save({ ...next, renewedAt: deps.now() });
    if (next.renewedAt === null) return next;
    const usage = await deps.devUsage(next.devProviderId);
    const readAt = usage?.fetchedAt ? Date.parse(usage.fetchedAt) : Number.NaN;
    if (usage?.status === "available" && !usage.authRecovery && readAt > next.renewedAt)
      return save({ ...next, provenAt: deps.now() });
    return next;
  }

  /**
   * What a new record inherits from the one it replaces. Every copy that may still be on Dev
   * keeps its directory and its clock, whatever happened in between, so each cap stays
   * absolute. The person Dev's home holds, and the person the owner last accepted, are both
   * accepted again; the owner's confirmation from the different-person warning accepts the
   * person it named. A restore gave Dev its own sign-in back, which the writer checks by itself,
   * and an undo that withdrew the projection and restored nothing left no one's projection.
   */
  function carriedFacts(previous: CodexAdoptionRecord | undefined) {
    if (!previous) return {};
    const copies = previous.copies ?? [];
    const kept = copies.length > 0 ? { copies } : {};
    const withdrawn = previous.status === "unadopted" && previous.restoreSkipped !== true;
    if (previous.restored !== null || withdrawn) return kept;
    const held = previous.heldIdentityDigest ?? null;
    const confirmed =
      previous.status === "needs-owner-confirmation" && previous.error === IDENTITY_CHANGED
        ? previous.pendingIdentityDigest
        : undefined;
    const expected = confirmed ?? previous.expectedIdentityDigest ?? held;
    return {
      ...kept,
      ...(expected ? { expectedIdentityDigest: expected } : {}),
      ...(held ? { heldIdentityDigest: held } : {}),
    };
  }

  /**
   * `days` deletes each saved copy at the earlier of proven + provenDays and its own cap, in
   * every state: also after a cancel, a failure, a changed home or an un-adopt that put nothing
   * back. Each cap counts from when that directory was first projected into.
   */
  async function applyRetention(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
    const rule = deps.retention(record.definitionId);
    if (rule.mode !== "days" || (record.copies ?? []).length === 0) return record;
    const proven =
      record.provenAt === null
        ? Number.POSITIVE_INFINITY
        : record.provenAt + rule.provenDays * DAY_MS;
    let next = record;
    for (const copy of record.copies ?? []) {
      const cap = copy.savedSince + rule.capDays * DAY_MS;
      if (deps.now() < Math.min(cap, proven)) continue;
      try {
        await deps.dev({
          ...scope(next),
          operation: "forget-copy",
          target: wireTarget(copy.target),
        });
      } catch (error) {
        // Past the cap the owner is told, rather than the copy outliving it silently.
        const reason =
          error instanceof CodexSignInRefused
            ? "Dev's folder for this account changed or moved."
            : "Dev could not be reached. It is tried again every hour.";
        if (deps.now() >= cap && next.copyDeleteBlocked !== reason)
          save({ ...next, copyDeleteBlocked: reason });
        throw error;
      }
      const current = next.target !== null && sameTarget(next.target, copy.target);
      next = save({
        ...next,
        copies: (next.copies ?? []).filter((item) => !sameTarget(item.target, copy.target)),
        copyDeleteBlocked: null,
        // The active home's copy is gone, so later projections there save none.
        ...(current ? { copyForgottenAt: deps.now() } : {}),
      });
    }
    return next;
  }

  /** In-memory: when retention may next try a record that is no longer delivering. */
  const retentionRetryAt = new Map<string, number>();
  async function retainOutsideDelivery(record: CodexAdoptionRecord): Promise<void> {
    if ((retentionRetryAt.get(record.definitionId) ?? 0) > deps.now()) return;
    try {
      await applyRetention(record);
      retentionRetryAt.delete(record.definitionId);
    } catch {
      // Dev offline, or the pinned directory is gone or changed: try again later.
      retentionRetryAt.set(record.definitionId, deps.now() + RETENTION_RETRY_MS);
    }
  }

  /** Withdraws the projection without any Host sign-out, then puts Dev's saved sign-in back. */
  async function advanceUnadopting(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
    const status = deps.refresher.status(record.definitionId);
    const delivering = record.target !== null && stillBound(record);
    if (status.signedIn) {
      if (delivering) await deps.refresher.signedOut(record.definitionId);
      else await deps.refresher.retire(record.definitionId);
    }
    if (delivering) {
      await deps.refresher.reconcile();
      if (!deps.refresher.withdrawn(record.definitionId)) return record;
    }
    let restored: CodexAdoptionRecord["restored"] = null;
    let error = record.error;
    if (delivering) {
      const target = record.target!;
      // Dev restores only a sign-in of a person this account has had: the one first projected
      // into this folder, whose sign-in its copy saved, or one the owner accepted since.
      const copy = (record.copies ?? []).find((item) => sameTarget(item.target, target));
      const persons = [copy?.person, record.heldIdentityDigest, record.expectedIdentityDigest];
      const named = [...new Set(persons.filter((item): item is string => Boolean(item)))];
      try {
        const result = z
          .discriminatedUnion("restored", [
            z.strictObject({ restored: z.literal(false) }),
            z.strictObject({ restored: z.literal(true), copyAgeMs: Counter }),
          ])
          .parse(
            await deps.dev({
              ...scope(record),
              operation: "restore",
              target: wireTarget(target),
              ...((await deps.pinByPath()) ? { persons: named } : {}),
            }),
          );
        if (result.restored) restored = { copyAgeMs: result.copyAgeMs, mayNeedSignIn: true };
      } catch (failure) {
        if (!(failure instanceof CodexSignInRefused)) throw failure;
        error ??= "Dev's folder for this account changed, so its earlier sign-in was not put back.";
      }
    }
    // Only a restore consumed this home's copy. With nothing restored it may still be on Dev, for
    // example when Dev's own renewal wrote auth.json first, so its entry and clock stay.
    const copies =
      restored !== null
        ? (record.copies ?? []).filter((item) => !sameTarget(item.target, record.target!))
        : record.copies;
    return save({
      ...record,
      status: error ? "failed" : "unadopted",
      restored,
      error,
      ...(copies ? { copies } : {}),
      // The binding moved while stopping, so nothing was withdrawn or put back.
      ...(delivering ? {} : { restoreSkipped: true as const }),
    });
  }

  /**
   * The folder an owner's stop can still withdraw from and restore into: a record paused for a
   * changed folder, on a Dev that pins by path, whose folder pins again at the same real path,
   * unshared, for an eligible account. Null otherwise, also when Dev cannot be reached.
   */
  async function stoppableFolder(record: CodexAdoptionRecord) {
    if (!folderChange(record)) return null;
    try {
      if (!(await deps.pinByPath()) || eligibility(record.definitionId).reason) return null;
      const { target } = CodexLegacyInspectResponseSchema.parse(
        await deps.dev({ ...scope(record), operation: "inspect" }),
      );
      const same = target.realpath === record.target!.realpath;
      return same && !sharesDirectory(record.definitionId, target) ? target : null;
    } catch {
      return null;
    }
  }

  /**
   * The status a record may resume to by itself: the one Dev's folder refusal paused, recorded
   * in the sidecar by this coordinator. A record without it, parked by the first adoption
   * release or with its sidecar missing, cannot tell a paused undo from a paused adoption and
   * waits for the owner.
   */
  function resumesTo(record: CodexAdoptionRecord): ParkedFrom | null {
    if (record.parkedReason !== "target_changed" || !folderChange(record)) return null;
    return record.parkedFrom ?? null;
  }

  /**
   * The folder the owner may confirm without Dev's session check: a record paused for a changed
   * folder after Dev acknowledged a projection, on a Dev that pins by path, whose folder at the
   * same real path holds this account's projection or nothing. Dev sessions there already run on
   * an access-only copy with no refresh token, so there is no Dev refresh to race. Null when
   * any of that does not hold; Dev being unreachable counts as not holding.
   */
  async function settledFolder(previous: CodexAdoptionRecord | undefined) {
    if (
      previous?.status !== "needs-owner-confirmation" ||
      previous.projectedAt === null ||
      previous.target === null ||
      !folderChange(previous)
    )
      return undefined;
    try {
      if (!(await deps.pinByPath())) return undefined;
      const inspection = CodexLegacyInspectResponseSchema.parse(
        await deps.dev({ ...scope(previous), operation: "inspect" }),
      );
      const same = inspection.target.realpath === previous.target.realpath;
      return same && inspection.signIn !== "other" ? inspection.target.realpath : undefined;
    } catch {
      return undefined;
    }
  }

  /** In-memory: when a paused record may next try to resume. */
  const resumeRetryAt = new Map<string, number>();

  /**
   * Resumes a record Dev paused for a changed folder, back to the status it paused, once a Dev
   * that identifies folders by real path pins the same path again, with every check the pin
   * makes. A paused undo continues the undo without Dev's idle check, which an undo never needs.
   * A paused adoption skips it only when Dev had acknowledged the projection and the folder holds
   * that projection or nothing; otherwise a Dev session on the account keeps the record waiting.
   */
  async function resume(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
    const to = resumesTo(record);
    if (to === null || (resumeRetryAt.get(record.definitionId) ?? 0) > deps.now()) return record;
    resumeRetryAt.set(record.definitionId, deps.now() + RESUME_RETRY_MS);
    if (!(await deps.pinByPath()) || eligibility(record.definitionId).reason) return record;
    const inspection = CodexLegacyInspectResponseSchema.parse(
      await deps.dev({ ...scope(record), operation: "inspect" }),
    );
    if (
      inspection.target.realpath !== record.target!.realpath ||
      sharesDirectory(record.definitionId, inspection.target)
    )
      return record;
    const settled = to === "unadopting" || (to === "adopted" && inspection.signIn !== "other");
    if (!settled && (await devUse(record))) return record;
    resumeRetryAt.delete(record.definitionId);
    return save({
      ...record,
      status: to,
      target: { ...record.target, ...inspection.target },
      parkedReason: undefined,
      parkedFrom: undefined,
      error: null,
    });
  }

  async function advanceRecord(
    record: CodexAdoptionRecord,
    settled?: string,
  ): Promise<CodexAdoptionRecord> {
    const watched =
      record.status === "projecting" ||
      record.status === "adopted" ||
      record.status === "needs-owner-confirmation";
    // Rebinding Dev by hand ends the adoption. Nothing in the home is touched.
    if (watched && !stillBound(record)) {
      await deps.refresher.retire(record.definitionId);
      return save({ ...record, status: "cancelled", error: null });
    }
    if (record.status === "verifying-host") return start(record, settled);
    // A restart between Host verification and the pin repeats both.
    if (record.status === "pinning") return start(record);
    if (record.status === "projecting") return advanceProjecting(record);
    if (record.status === "unadopting") return advanceUnadopting(record);
    if (record.status === "needs-owner-confirmation") return resume(record);
    if (record.status !== "adopted") return record;
    // Codex saves its own refresh under a lock this writer does not take, so each reconcile
    // re-sends the current projection; Dev replaces a newer local sign-in of the same account.
    await deps.refresher.recover(record.definitionId).catch(() => {});
    const proven = await trackProof(find(record.definitionId) ?? record);
    return applyRetention(proven);
  }

  /** Runs one step. A refusal fails the record; anything else leaves it to retry. */
  async function step(
    record: CodexAdoptionRecord,
    settled?: string,
    onRefused?: (error: AdoptionRefused) => void,
  ): Promise<CodexAdoptionRecord> {
    try {
      return await advanceRecord(record, settled);
    } catch (error) {
      if (!(error instanceof AdoptionRefused)) return find(record.definitionId) ?? record;
      onRefused?.(error);
      const current = find(record.definitionId) ?? record;
      // Before the first projection nothing was written; a failure changes nothing else.
      return save({ ...current, status: "failed", error: error.message });
    }
  }

  return {
    record: find,

    /**
     * Every legacy Codex definition (an `accountId`, no `accountSetup`), with the plain reason it
     * cannot be adopted as things stand, or null, and its adoption record. For the owner's list.
     */
    legacy(): Array<{
      definitionId: string;
      reason: string | null;
      record: CodexAdoptionRecord | null;
    }> {
      const { records } = load();
      return (deps.settings.snapshot().settings?.providerDefinitions ?? [])
        .filter(
          (definition) =>
            definition.providerType === "codex" &&
            definition.accountId !== undefined &&
            definition.accountSetup === undefined,
        )
        .map((definition) => ({
          definitionId: definition.id,
          // Retention cannot run on a record it cannot read, so the owner is told.
          reason: unreadableFor(definition.id, "adopt") ?? eligibility(definition.id).reason,
          record: records.find((item) => item.definitionId === definition.id) ?? null,
        }));
    },

    /** Whether the refresher may project into this definition's legacy Dev home. */
    delivering(definitionId: string): CodexAdoptionRecord | null {
      const record = find(definitionId);
      return record && DELIVERING.has(record.status) && record.target ? record : null;
    },

    /** Owner selection only. Starts one adoption; a second waits for the first to finish. */
    adopt(definitionId: string): Promise<CodexAdoptionRecord> {
      return serialized(async () => {
        const unreadable = unreadableFor(definitionId, "adopt");
        if (unreadable) throw new CodexAdoptionUnreadable(unreadable);
        const { records } = load();
        if (
          records.some((item) => item.definitionId !== definitionId && IN_PROGRESS.has(item.status))
        )
          throw new CodexAdoptionBusy();
        const previous = records.find((item) => item.definitionId === definitionId);
        if (previous && (IN_PROGRESS.has(previous.status) || previous.status === "adopted"))
          return previous;
        if (previous?.status === "needs-owner-confirmation" && previous.parkedFrom === "unadopting")
          throw new CodexAdoptionStopping();
        const check = eligibility(definitionId);
        const carried = carriedFacts(previous);
        if (check.reason)
          return save({
            ...fresh(definitionId, check.binding),
            ...carried,
            status: "failed",
            error: check.reason,
          });
        // Judged on the paused record before it is replaced; only this confirmation uses it.
        const settled = await settledFolder(previous);
        const record = save({
          ...fresh(definitionId, check.binding),
          ...carried,
          status: "verifying-host",
        });
        const refused: { busy?: SameGrantBusy } = {};
        const next = await step(record, settled, (error) => {
          if (error instanceof SameGrantBusy) refused.busy = error;
        });
        // The threads' titles reach the owner in this reply only, never the record or a log.
        if (refused.busy) throw new CodexAdoptionRefusal(refused.busy.ownerMessage);
        if (next.status === "projecting") await deps.refresher.reconcile();
        return find(definitionId) ?? next;
      });
    },

    /** Owner only. Never signs the Host out. */
    unadopt(definitionId: string): Promise<CodexAdoptionRecord> {
      return serialized(async () => {
        const unreadable = unreadableFor(definitionId, "unadopt");
        if (unreadable) throw new CodexAdoptionUnreadable(unreadable);
        const record = find(definitionId);
        if (!record || record.status === "unadopted") throw new CodexSignInDeliveryError();
        // A folder change whose folder still pins at the same path is withdrawn and restored.
        const folder = await stoppableFolder(record);
        if (folder)
          return step(
            save({
              ...record,
              status: "unadopting",
              target: { ...record.target, ...folder },
              parkedReason: undefined,
              parkedFrom: undefined,
              error: null,
            }),
          );
        if (
          record.status === "cancelled" ||
          record.status === "failed" ||
          record.status === "needs-owner-confirmation" ||
          record.target === null
        ) {
          // Nothing is withdrawn or restored from here: the binding moved, the home changed or no
          // longer pins, Dev is older, another person is waiting, or nothing was delivered. The
          // record says so, and retention still applies to any copy.
          await deps.refresher.retire(definitionId);
          return save({ ...record, status: "unadopted", restoreSkipped: true });
        }
        return step(save({ ...record, status: "unadopting", error: null }));
      });
    },

    /** The 30-second tick: one step for each record that is not finished. */
    reconcile(): Promise<void> {
      return serialized(async () => {
        for (const record of load().records) {
          if (record.status === "failed") {
            // A first projection Dev refused fails the record inside the refresher's own
            // delivery, where it cannot retire it. Retire it here so it stops delivering.
            await deps.refresher.retire(record.definitionId).catch(() => {});
          }
          if (OUTSIDE_DELIVERY.has(record.status)) {
            await retainOutsideDelivery(record);
            continue;
          }
          const next = await step(record);
          // Waiting for the owner still watches for a rebind; its copy keeps its retention.
          if (next.status === "needs-owner-confirmation") await retainOutsideDelivery(next);
        }
      });
    },

    /** Dev refused a delivery: its home changed, or it holds a sign-in that cannot be replaced. */
    refused(definitionId: string, reason: CodexSignInRefused["reason"]): void {
      const record = find(definitionId);
      if (!record || !DELIVERING.has(record.status)) return;
      if (reason === "target_changed")
        save({
          ...record,
          status: "needs-owner-confirmation",
          error: TARGET_CHANGED,
          parkedReason: "target_changed",
          parkedFrom: ParkedFromSchema.parse(record.status),
        });
      // An adopted home stays pending; only a first projection fails the adoption.
      else if (reason === "existing_sign_in" && record.status === "projecting")
        save({
          ...record,
          status: "failed",
          error: "Dev is signed in to this account as someone else. Nothing was changed.",
        });
    },

    /**
     * Whether a projection of this Host sign-in may reach the adopted Dev home: only for the
     * person verified when the owner set it up. A different person, or a record from before the
     * digest existed, waits for the owner's confirmation, which verifies and pins again.
     */
    admitsHostIdentity(
      definitionId: string,
      access: { accountId: string | null; idToken: string },
    ): boolean {
      const record = find(definitionId);
      if (!record || !DELIVERING.has(record.status)) return false;
      const digest = codexSignInKeyDigest(access.accountId, access.idToken);
      if (digest && record.hostIdentityDigest && digest === record.hostIdentityDigest) return true;
      if (record.status !== "unadopting")
        save({
          ...record,
          status: "needs-owner-confirmation",
          error: IDENTITY_CHANGED,
          parkedReason: "identity_changed",
          pendingIdentityDigest: digest,
        });
      return false;
    },

    replacedLocally(definitionId: string): void {
      const record = find(definitionId);
      if (record) save({ ...record, replacedLocallyAt: deps.now() });
    },
  };
}
export type CodexAdoption = ReturnType<typeof createCodexAdoption>;
