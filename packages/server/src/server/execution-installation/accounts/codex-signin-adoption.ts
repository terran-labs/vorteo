import { z } from "zod";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { CodexAdoptionRetention, InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import {
  CodexLegacyTargetSchema,
  CodexSignInDeliveryError,
  CodexSignInRefused,
  type CodexLegacyTarget,
} from "./codex-signin-delivery.js";
import { verifyCodexHostSession, type CodexHostGrant } from "./codex-signin-host.js";
import { codexSignInKeyDigest } from "./codex-signin-identity.js";
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
const DAY_MS = 24 * 60 * 60_000;

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

/** Secret-free: identifiers, a directory pin and times. No account ID, email or token. */
const AdoptionRecordSchema = z.strictObject({
  definitionId: z.string().min(1),
  status: CodexAdoptionStatusSchema,
  devServerId: z.string().min(1),
  /** Dev's binding as it is in settings. A different binding later cancels the adoption. */
  devProviderId: z.string().min(1),
  hostProviderId: z.string().min(1),
  target: CodexLegacyTargetSchema.nullable(),
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
  restored: z.strictObject({ copyAgeMs: Counter, mayNeedSignIn: z.literal(true) }).nullable(),
  /**
   * Un-adopted from a cancelled, failed or confirmation-pending record: nothing was withdrawn or
   * put back, so whatever is in Dev's home stays as it is. The app says so plainly.
   */
  restoreSkipped: z.literal(true).optional(),
  /**
   * SHA-256 of the workspace and person the Host was signed in as when the owner set this up.
   * Every projection must match it; a different person waits for the owner. Never raw IDs.
   */
  /**
   * Every pinned Dev directory this account was projected into whose saved copy may still exist,
   * each with its own clock. Carried across records, so a re-switch into another directory, a
   * failed retry or a refusal never drops one, and each copy is deleted at its own cap.
   */
  copies: z
    .array(z.strictObject({ target: CodexLegacyTargetSchema, savedSince: Counter }))
    .max(8)
    .optional(),
  /** The person whose projection Dev's home holds, from the record that last projected. */
  heldIdentityDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  /**
   * The person this record must find on the Host, carried from an earlier record whose Dev home
   * may still hold that person's projection. A different person waits for the owner.
   */
  expectedIdentityDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  /** The different person found on the Host, which the owner's confirmation accepts. */
  pendingIdentityDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  /** Past the retention cap, the plain reason the saved copy on Dev could not be deleted. */
  copyDeleteBlocked: z.string().max(300).nullable().optional(),
  hostIdentityDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  error: z.string().max(300).nullable(),
});
export type CodexAdoptionRecord = z.infer<typeof AdoptionRecordSchema>;
export const CodexAdoptionJournalSchema = z.array(AdoptionRecordSchema);

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
function sameTarget(a: CodexLegacyTarget, b: CodexLegacyTarget): boolean {
  return a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino;
}

/** Adds a directory's copy once; an existing entry keeps its earlier clock. */
function withCopy(
  copies: Array<{ target: CodexLegacyTarget; savedSince: number }> | undefined,
  target: CodexLegacyTarget,
  now: number,
) {
  const list = copies ?? [];
  if (list.some((item) => sameTarget(item.target, target))) return list;
  return [...list, { target, savedSince: now }].slice(-8);
}

/** Retention retries for records outside delivery wait this long after a failed attempt. */
const RETENTION_RETRY_MS = 60 * 60_000;

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

export class CodexAdoptionBusy extends Error {
  constructor() {
    super("Another Codex account is switching to the Host's sign-in. Wait for it to finish.");
  }
}

/** A step that cannot succeed as things stand. Its message is the plain reason shown later. */
class AdoptionRefused extends Error {}

export interface CodexAdoptionJournal {
  read(): CodexAdoptionRecord[];
  write(records: CodexAdoptionRecord[]): void;
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

  function find(definitionId: string): CodexAdoptionRecord | undefined {
    return deps.journal.read().find((item) => item.definitionId === definitionId);
  }

  function save(record: CodexAdoptionRecord): CodexAdoptionRecord {
    deps.journal.write([
      ...deps.journal.read().filter((item) => item.definitionId !== record.definitionId),
      record,
    ]);
    return record;
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

  /** Verify the Host, then Dev's session state and home, then start projecting. */
  async function start(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
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
        pendingIdentityDigest: hostIdentityDigest,
      });
    const pinning = save({ ...record, status: "pinning", hostIdentityDigest });
    const sessions = z
      .strictObject({ active: z.boolean() })
      .parse(
        await devRequest(
          { ...scope(pinning), operation: "sessions" },
          "Dev did not accept this account's setup. Refresh and try again.",
        ),
      );
    if (sessions.active) throw new AdoptionRefused(ACTIVE_DEV_SESSION);
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
    // Read once more: the Host file may have changed while Dev answered.
    const { identity, digest } = await verifyHost(pinning, deps.settings.snapshot().revision);
    if (digest !== hostIdentityDigest) throw new AdoptionRefused(IDENTITY_CHANGED);
    const projecting = save({
      ...pinning,
      status: "projecting",
      target,
      copies: withCopy(pinning.copies, target, deps.now()),
      heldIdentityDigest: hostIdentityDigest,
    });
    await deps.refresher.connected(record.definitionId, identity);
    return projecting;
  }

  function sharesDirectory(definitionId: string, target: CodexLegacyTarget): boolean {
    return deps.journal
      .read()
      .some(
        (other) =>
          other.definitionId !== definitionId &&
          HOLDING.has(other.status) &&
          other.target !== null &&
          (other.target.realpath === target.realpath ||
            (other.target.dev === target.dev && other.target.ino === target.ino)),
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
   * person it named. A restore gave Dev its own sign-in back, which the writer checks by itself.
   */
  function carriedFacts(previous: CodexAdoptionRecord | undefined) {
    if (!previous) return {};
    const copies = previous.copies ?? [];
    const kept = copies.length > 0 ? { copies } : {};
    if (previous.restored !== null) return kept;
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
        await deps.dev({ ...scope(next), operation: "forget-copy", target: copy.target });
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
      try {
        const result = z
          .discriminatedUnion("restored", [
            z.strictObject({ restored: z.literal(false) }),
            z.strictObject({ restored: z.literal(true), copyAgeMs: Counter }),
          ])
          .parse(await deps.dev({ ...scope(record), operation: "restore", target: record.target }));
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
    });
  }

  async function advanceRecord(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
    const watched =
      record.status === "projecting" ||
      record.status === "adopted" ||
      record.status === "needs-owner-confirmation";
    // Rebinding Dev by hand ends the adoption. Nothing in the home is touched.
    if (watched && !stillBound(record)) {
      await deps.refresher.retire(record.definitionId);
      return save({ ...record, status: "cancelled", error: null });
    }
    if (record.status === "verifying-host") return start(record);
    // A restart between Host verification and the pin repeats both.
    if (record.status === "pinning") return start(record);
    if (record.status === "projecting") return advanceProjecting(record);
    if (record.status === "unadopting") return advanceUnadopting(record);
    if (record.status !== "adopted") return record;
    // Codex saves its own refresh under a lock this writer does not take, so each reconcile
    // re-sends the current projection; Dev replaces a newer local sign-in of the same account.
    await deps.refresher.recover(record.definitionId).catch(() => {});
    const proven = await trackProof(find(record.definitionId) ?? record);
    return applyRetention(proven);
  }

  /** Runs one step. A refusal fails the record; anything else leaves it to retry. */
  async function step(record: CodexAdoptionRecord): Promise<CodexAdoptionRecord> {
    try {
      return await advanceRecord(record);
    } catch (error) {
      if (!(error instanceof AdoptionRefused)) return find(record.definitionId) ?? record;
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
      const records = deps.journal.read();
      return (deps.settings.snapshot().settings?.providerDefinitions ?? [])
        .filter(
          (definition) =>
            definition.providerType === "codex" &&
            definition.accountId !== undefined &&
            definition.accountSetup === undefined,
        )
        .map((definition) => ({
          definitionId: definition.id,
          reason: eligibility(definition.id).reason,
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
        const records = deps.journal.read();
        if (
          records.some((item) => item.definitionId !== definitionId && IN_PROGRESS.has(item.status))
        )
          throw new CodexAdoptionBusy();
        const previous = records.find((item) => item.definitionId === definitionId);
        if (previous && (IN_PROGRESS.has(previous.status) || previous.status === "adopted"))
          return previous;
        const check = eligibility(definitionId);
        const carried = carriedFacts(previous);
        if (check.reason)
          return save({
            ...fresh(definitionId, check.binding),
            ...carried,
            status: "failed",
            error: check.reason,
          });
        const record = save({
          ...fresh(definitionId, check.binding),
          ...carried,
          status: "verifying-host",
        });
        const next = await step(record);
        if (next.status === "projecting") await deps.refresher.reconcile();
        return find(definitionId) ?? next;
      });
    },

    /** Owner only. Never signs the Host out. */
    unadopt(definitionId: string): Promise<CodexAdoptionRecord> {
      return serialized(async () => {
        const record = find(definitionId);
        if (!record || record.status === "unadopted") throw new CodexSignInDeliveryError();
        if (
          record.status === "cancelled" ||
          record.status === "failed" ||
          record.status === "needs-owner-confirmation" ||
          record.target === null
        ) {
          // Nothing is withdrawn or restored from here: the binding moved, the home changed, or
          // nothing was delivered. The record says so, and retention still applies to any copy.
          await deps.refresher.retire(definitionId);
          return save({ ...record, status: "unadopted", restoreSkipped: true });
        }
        return step(save({ ...record, status: "unadopting", error: null }));
      });
    },

    /** The 30-second tick: one step for each record that is not finished. */
    reconcile(): Promise<void> {
      return serialized(async () => {
        for (const record of deps.journal.read()) {
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
          error: "Dev's folder for this account changed. Confirm to try again.",
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
