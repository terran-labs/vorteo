import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  LEAN_PROTOCOL_MAJOR,
  type Installation,
  type Lease,
  type LeaseAcquire,
  type LeasePort,
} from "../types.js";

export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const opaqueId = z.string().regex(/^[A-Za-z0-9_/-]{1,160}$/);
const recordSchema = z
  .object({
    version: z.literal(1),
    installation: opaqueId,
    generation: z.string().uuid(),
    nonce: z.string().uuid(),
    expiresAt: z.number().int().positive().max(8_640_000_000_000).safe(),
    released: z.boolean(),
    submission: z
      .object({
        head: sha,
        builderProviderType: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();
const envelopeSchema = z
  .object({
    record: recordSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const unsignedHostEnvelope = z.strictObject({
  kind: z.literal("unsigned-host"),
  repository: z.string(),
  issue: z.number().int().positive().safe(),
  record: recordSchema.extend({ submission: z.null() }),
});

export type ClaimRecord = z.infer<typeof recordSchema>;
export interface ClaimSnapshot {
  revision: string;
  record: ClaimRecord;
}

export interface ClaimRefStore {
  read(issue: number): Promise<{ revision: string; body: string } | null>;
  compareAndSwap(issue: number, expected: string | null, body: string | null): Promise<boolean>;
}

export interface MachineClaimOptions {
  repository: string;
  installation: Installation;
  refs: ClaimRefStore;
  now(): Date;
  sign(payload: Uint8Array): string | Promise<string>;
  verify(
    installation: Installation,
    payload: Uint8Array,
    signature: string,
  ): boolean | Promise<boolean>;
  /** Retain the issue trust and protected-file checks before attempting a claim. */
  prepare(
    issue: number,
  ): Promise<
    Extract<LeaseAcquire, { outcome: "refused" }> | { brief: string; checkedHeadSha: string | null }
  >;
  readWorkHead(issue: number): Promise<string | null>;
  /** Create the missing work branch from the default branch without replacing an existing ref. */
  ensureWorkBranch(issue: number): Promise<void>;
  /**
   * Quiesce the local runner and save its work against the supplied claim and branch tips.
   * A non-atomic work push stays quarantined until independently registered. Return the intended head.
   */
  pushSavedWork(
    issue: number,
    expected: {
      claimRevision: string;
      workHead: string | null;
    },
  ): Promise<string>;
  isPrimary(): boolean | Promise<boolean>;
}

export type UnsignedHostClaimOptions = Omit<MachineClaimOptions, "sign" | "verify">;

export interface MachineLeasePort extends LeasePort {
  readClaim(issue: number): Promise<ClaimSnapshot | null>;
  readLease(issue: number): Promise<Lease | null>;
  registerSubmission(
    issue: number,
    expectedRevision: string,
    intendedHead: string,
    builderProviderType: string,
  ): Promise<void>;
  readSubmission(issue: number, pullHead: string): Promise<ClaimSnapshot | null>;
  /** Called by the primary after confirming the issue is complete. */
  deleteCompletedClaim(issue: number, expectedRevision: string): Promise<boolean>;
}

function signingBytes(repository: string, issue: number, record: ClaimRecord): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      "vorteo/factory/claim/v1",
      repository.toLowerCase(),
      issue,
      record.installation,
      record.generation,
      record.nonce,
      record.expiresAt,
      record.released,
      record.submission ? [record.submission.head, record.submission.builderProviderType] : null,
    ]),
  );
}

function workBranch(issue: number): string {
  return `factory/issue-${issue}`;
}

type ClaimKeys = Pick<MachineClaimOptions, "repository" | "installation" | "sign" | "verify">;
type ClaimIdentity = Pick<ClaimKeys, "repository" | "installation">;
type ClaimFields = Omit<ClaimRecord, "version" | "installation" | "nonce">;

interface EncodedClaim {
  record: ClaimRecord;
  body: string;
  assertCurrent(): Promise<void>;
}

interface ClaimEncoding {
  signed: boolean;
  read(refs: ClaimRefStore, issue: number): Promise<ClaimSnapshot | null>;
  encode(issue: number, fields: ClaimFields): Promise<EncodedClaim>;
}

async function readVerifiedRecord(
  options: ClaimKeys,
  refs: ClaimRefStore,
  issue: number,
): Promise<ClaimSnapshot | null> {
  const current = await refs.read(issue);
  if (!current) return null;
  const { record, signature } = envelopeSchema.parse(JSON.parse(current.body));
  if (
    Buffer.from(signature, "base64").toString("base64") !== signature ||
    !(await options.verify(
      record.installation,
      signingBytes(options.repository, issue, record),
      signature,
    ))
  ) {
    throw new Error("Factory claim signature is invalid.");
  }
  return { revision: current.revision, record };
}

async function signRecord(
  options: ClaimKeys,
  issue: number,
  fields: ClaimFields,
): Promise<EncodedClaim> {
  const record = recordSchema.parse({
    version: 1,
    installation: options.installation,
    nonce: randomUUID(),
    ...fields,
  });
  const payload = signingBytes(options.repository, issue, record);
  const signature = await options.sign(payload);
  if (!(await options.verify(record.installation, payload, signature))) {
    throw new Error("The active Factory signing key is not enrolled for this installation.");
  }
  return {
    record,
    body: JSON.stringify(envelopeSchema.parse({ record, signature })),
    async assertCurrent() {
      if (!(await options.verify(record.installation, payload, signature)))
        throw new SavedClaimReleaseRefusal("The paused release signing key is no longer enrolled.");
    },
  };
}

function signedEncoding(options: ClaimKeys): ClaimEncoding {
  return {
    signed: true,
    read: (refs, issue) => readVerifiedRecord(options, refs, issue),
    encode: (issue, fields) => signRecord(options, issue, fields),
  };
}

function unsignedHostEncoding(options: ClaimIdentity): ClaimEncoding {
  const repository = options.repository.toLowerCase();
  return {
    signed: false,
    async read(refs, issue) {
      const current = await refs.read(issue);
      if (!current) return null;
      const envelope = unsignedHostEnvelope.parse(JSON.parse(current.body));
      if (envelope.repository !== repository || envelope.issue !== issue)
        throw new Error(
          "The unsigned Host dispatch claim belongs to a different issue or repository.",
        );
      return { revision: current.revision, record: envelope.record };
    },
    async encode(issue, fields) {
      const envelope = unsignedHostEnvelope.parse({
        kind: "unsigned-host",
        repository,
        issue,
        record: { version: 1, installation: options.installation, nonce: randomUUID(), ...fields },
      });
      return { record: envelope.record, body: JSON.stringify(envelope), async assertCurrent() {} };
    },
  };
}

export class SavedClaimReleaseRefusal extends Error {}

interface SavedClaimReleaseInput {
  issue: number;
  claimRevision: string;
  claimGeneration: string;
  savedHead: string;
}

type SavedClaimReleaseOptions = ClaimIdentity &
  Pick<MachineClaimOptions, "now" | "readWorkHead"> & {
    assertPaused(): Promise<void>;
    openReleaseStore(authorizePush: () => Promise<void>): ClaimRefStore;
  };

export function releaseSavedClaim(
  options: SavedClaimReleaseOptions & ClaimKeys,
  target: SavedClaimReleaseInput,
) {
  return releaseExactClaim(options, target, signedEncoding(options));
}

export function releaseSavedHostClaim(
  options: SavedClaimReleaseOptions,
  target: SavedClaimReleaseInput,
) {
  return releaseExactClaim(options, target, unsignedHostEncoding(options));
}

/** Release only an exact claim for independently verified saved work. The store
 * must call authorizePush at its native mutation boundary, after charging and before Git. */
async function releaseExactClaim(
  options: SavedClaimReleaseOptions,
  target: SavedClaimReleaseInput,
  encoding: ClaimEncoding,
): Promise<{ expiresAt: string }> {
  const { issue, claimRevision, claimGeneration, savedHead } = target;
  z.number().int().positive().safe().parse(issue);
  sha.parse(claimRevision);
  sha.parse(savedHead);
  z.string().uuid().parse(claimGeneration);
  async function assertHead() {
    if ((await options.readWorkHead(issue)) !== savedHead) {
      throw new SavedClaimReleaseRefusal(
        "The remote Builder branch no longer matches the independently verified saved commit.",
      );
    }
  }

  await options.assertPaused();
  let deadline: number | undefined;
  let candidate: EncodedClaim | undefined;
  let pushAuthorized = false;
  const refs = options.openReleaseStore(async () => {
    if (deadline === undefined || !candidate || pushAuthorized)
      throw new SavedClaimReleaseRefusal("The paused claim push was outside its authorized scope.");
    await assertHead();
    await options.assertPaused();
    if (deadline <= +options.now())
      throw new SavedClaimReleaseRefusal("The claim expired before its paused release.");
    await candidate.assertCurrent();
    pushAuthorized = true;
  });
  const original = await encoding.read(refs, issue);
  if (
    !original ||
    original.revision !== claimRevision ||
    original.record.generation !== claimGeneration ||
    original.record.installation !== options.installation ||
    original.record.released ||
    original.record.expiresAt * 1000 <= +options.now()
  ) {
    throw new SavedClaimReleaseRefusal("The claim changed or expired before paused release.");
  }
  deadline = original.record.expiresAt * 1000;
  await assertHead();
  await options.assertPaused();
  candidate = await encoding.encode(issue, {
    generation: claimGeneration,
    expiresAt: original.record.expiresAt,
    released: true,
    submission: null,
  });
  const pushed = await refs
    .compareAndSwap(issue, claimRevision, candidate.body)
    .catch((error: unknown) => {
      if (pushAuthorized) throw uncertainRelease(error);
      throw error;
    });
  if (!pushed) {
    throw new SavedClaimReleaseRefusal(
      "The claim changed before its paused release could be saved.",
    );
  }
  try {
    const confirmed = await encoding.read(refs, issue);
    if (!pushAuthorized || !isDeepStrictEqual(confirmed?.record, candidate.record)) {
      throw new SavedClaimReleaseRefusal("The paused release could not be verified.");
    }
    await assertHead();
  } catch (error) {
    throw uncertainRelease(error);
  }
  return { expiresAt: new Date(deadline).toISOString() };
}

function uncertainRelease(cause: unknown): SavedClaimReleaseRefusal {
  return new SavedClaimReleaseRefusal(
    "The claim update may have landed, but the saved branch and release could not be confirmed. The Builder worktree was kept.",
    { cause },
  );
}

export function createMachineLeasePort(options: MachineClaimOptions): MachineLeasePort {
  return createClaimLeasePort(options, signedEncoding(options));
}

/** Unsigned claims schedule Host builds only. They supply no approval or submission evidence. */
export function createUnsignedHostLeasePort(options: UnsignedHostClaimOptions): MachineLeasePort {
  return createClaimLeasePort(options, unsignedHostEncoding(options));
}

function createClaimLeasePort(
  options: UnsignedHostClaimOptions,
  encoding: ClaimEncoding,
): MachineLeasePort {
  const installation = opaqueId.parse(options.installation);
  const observations = new Map<number, { revision: string; head: string | null; since: number }>();

  function lease(issue: number, record: ClaimRecord, seenSince = options.now().getTime()): Lease {
    return {
      issue,
      branch: workBranch(issue),
      installation: record.installation,
      renewedAt: new Date(record.expiresAt * 1000 - CLAIM_TTL_MS).toISOString(),
      expiresAt: new Date(record.expiresAt * 1000).toISOString(),
      seenUnchangedSince: new Date(seenSince).toISOString(),
      protocol: LEAN_PROTOCOL_MAJOR,
      released: record.released,
    };
  }

  function active(record: ClaimRecord): boolean {
    return !record.released && record.expiresAt * 1000 > options.now().getTime();
  }

  async function write(
    issue: number,
    expected: string | null,
    fields: Omit<ClaimRecord, "version" | "installation" | "nonce">,
  ): Promise<ClaimRecord | null> {
    const { record, body } = await encoding.encode(issue, fields);
    return (await options.refs.compareAndSwap(issue, expected, body)) ? record : null;
  }

  function deadline(): number {
    return Math.ceil((options.now().getTime() + CLAIM_TTL_MS) / 1000);
  }

  async function ownActiveClaim(issue: number) {
    const { current, head } = await observe(issue);
    if (!current || current.record.installation !== installation || !active(current.record)) {
      throw new Error("This installation no longer holds the Factory claim.");
    }
    return { current, head };
  }

  async function observe(issue: number) {
    const current = await encoding.read(options.refs, issue);
    const head = await options.readWorkHead(issue);
    if (!current) {
      observations.delete(issue);
      return { current, head, since: options.now().getTime() };
    }
    const previous = observations.get(issue);
    if (previous?.revision === current.revision && previous.head === head) {
      return { current, head, since: previous.since };
    }
    const since = options.now().getTime();
    observations.set(issue, { revision: current.revision, head, since });
    return { current, head, since };
  }

  async function readClaim(issue: number): Promise<ClaimSnapshot | null> {
    return (await observe(issue)).current;
  }

  function expired(entry: Lease, now: Date): boolean {
    return (
      !entry.released &&
      Date.parse(entry.expiresAt) <= now.getTime() &&
      Date.parse(entry.seenUnchangedSince) + CLAIM_TTL_MS <= now.getTime()
    );
  }

  async function confirmLease(
    issue: number,
    head: string | null,
    expected: ClaimRecord,
  ): Promise<Lease> {
    if (!head) await options.ensureWorkBranch(issue);
    const after = await observe(issue);
    if (!after.head || !isDeepStrictEqual(after.current?.record, expected) || !active(expected)) {
      throw new Error("Factory could not confirm the claim and work branch after acquisition.");
    }
    return lease(issue, expected, after.since);
  }

  return {
    readClaim,
    async readLease(issue) {
      const { current, since } = await observe(issue);
      return current ? lease(issue, current.record, since) : null;
    },
    async acquire(issue) {
      const ready = await options.prepare(issue);
      if ("outcome" in ready) return ready;
      const { current, head, since } = await observe(issue);
      if (ready.checkedHeadSha && ready.checkedHeadSha !== head) {
        return {
          outcome: "refused",
          code: "head-moved",
          reason: "Recheck the pull request after its head settles.",
        };
      }
      if (!current && head) {
        return {
          outcome: "refused",
          code: "unsigned-work-branch",
          reason:
            "Reconcile the existing work branch before enabling machine claims for this issue.",
        };
      }
      const result = { ...ready, continueFrom: head ? workBranch(issue) : null };
      if (current && !current.record.released) {
        const existing = lease(issue, current.record, since);
        if (current.record.installation === installation && active(current.record)) {
          return {
            outcome: "held",
            lease: await confirmLease(issue, head, current.record),
            ...result,
          };
        }
        if (!expired(existing, options.now())) return { outcome: "foreign", lease: existing };
      }
      const saved = await write(issue, current?.revision ?? null, {
        generation: randomUUID(),
        expiresAt: deadline(),
        released: false,
        submission: null,
      });
      if (!saved) {
        const winner = await readClaim(issue);
        return { outcome: "foreign", lease: winner ? lease(issue, winner.record) : null };
      }
      return { outcome: "claimed", lease: await confirmLease(issue, head, saved), ...result };
    },
    async renew(issue) {
      const { current, head } = await ownActiveClaim(issue);
      if (!active(current.record)) throw new Error("Factory claim expired before renewal.");
      const saved = await write(issue, current.revision, {
        generation: current.record.generation,
        expiresAt: deadline(),
        released: false,
        submission: head === current.record.submission?.head ? current.record.submission : null,
      });
      if (!saved) throw new Error("Factory claim changed during renewal.");
      return lease(issue, saved);
    },
    async release(issue, why) {
      const { current, head: workHead } = await observe(issue);
      if (!current || current.record.released || current.record.installation !== installation)
        return;
      if (why === "takeover") throw new Error("Acquire an expired Factory claim to take it over.");
      if (!active(current.record)) throw new Error("Factory claim expired before release.");
      if (why !== "done") {
        const head = sha.parse(
          await options.pushSavedWork(issue, {
            claimRevision: current.revision,
            workHead,
          }),
        );
        if (head !== (await options.readWorkHead(issue)) || !active(current.record)) {
          throw new Error(
            "Factory could not confirm the saved work head before releasing its claim.",
          );
        }
      }
      const saved = await write(issue, current.revision, {
        generation: current.record.generation,
        expiresAt: current.record.expiresAt,
        released: true,
        submission: null,
      });
      if (!saved) throw new Error("Factory claim changed before release.");
    },
    expired(entries, now) {
      return entries.filter((entry) => expired(entry, now));
    },
    async registerSubmission(issue, expectedRevision, intendedHead, builderProviderType) {
      if (!encoding.signed)
        throw new Error("Unsigned Host claims cannot register trusted submissions.");
      sha.parse(intendedHead);
      const { current, head } = await ownActiveClaim(issue);
      if (
        current.revision !== expectedRevision ||
        intendedHead !== head ||
        !active(current.record)
      ) {
        throw new Error("Factory submission no longer matches the claim and work branch.");
      }
      const saved = await write(issue, current.revision, {
        generation: current.record.generation,
        expiresAt: current.record.expiresAt,
        released: false,
        submission: { head: intendedHead, builderProviderType },
      });
      if (!saved) throw new Error("Factory claim changed before the submission was registered.");
    },
    async readSubmission(issue, pullHead) {
      if (!encoding.signed) return null;
      const { current, head } = await observe(issue);
      if (
        !current ||
        !active(current.record) ||
        current.record.submission?.head !== pullHead ||
        head !== pullHead
      )
        return null;
      const after = await observe(issue);
      return after.current?.revision === current.revision &&
        active(after.current.record) &&
        after.head === pullHead
        ? after.current
        : null;
    },
    async deleteCompletedClaim(issue, expectedRevision) {
      if (!(await options.isPrimary()))
        throw new Error("Only the Factory primary can delete a completed claim.");
      const current = await readClaim(issue);
      if (current?.revision !== expectedRevision) return false;
      const deleted = await options.refs.compareAndSwap(issue, expectedRevision, null);
      if (deleted) observations.delete(issue);
      return deleted;
    },
  };
}
