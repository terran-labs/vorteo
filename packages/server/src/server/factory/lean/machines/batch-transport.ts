import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import type { FactoryGitHub } from "../../project/claims.js";
import type { GateCommandExecution, IssueGateCommand } from "../gate-receipts.js";
import type { IssueGateInputs } from "../gate-runtime.js";
import type { LeanLedger, LeanStateStore } from "../types.js";
import { createGitClaimStore, type GitClaimStoreOptions } from "./claim-git.js";
import type { ClaimRefStore } from "./claims.js";
import {
  loadNativeHostSigningKey,
  readMachinePublicKey,
  signMachinePayload,
  verifyMachinePayload,
} from "./host-key.js";
import { readPinnedFactoryConfig } from "./pinned-factory-config.js";
import { resolveMachineRoles, type MachineRoles } from "./roles.js";
import {
  createHeavyGateVerifier,
  createNativeHeavyGateSigner,
  heavyGateChallengeBytes,
  isOpenHeavyGateChallenge,
  sameHeavyGateBatch,
  type HeavyGateBatch,
  type HeavyGateChallenge,
  type SignedHeavyGateReceipt,
} from "./signed-gates.js";

const objectId = z.string().regex(/^[a-f0-9]{40}$/u);
const installation = z
  .string()
  .regex(/^[\w-]+\/[\w-]+$/u)
  .max(160);
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u);
const batchIdSchema = z
  .string()
  .regex(/^[\w-]+$/u)
  .max(160);
const command = z.strictObject({
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  where: z.literal("container"),
  requiredOutput: z.string().min(1).max(4096).optional(),
});
const challengeSchema = z.strictObject({
  batchId: batchIdSchema,
  target: z.strictObject({
    repository: z.string().max(160),
    issue: z.number().int().positive(),
    primary: installation,
    configCommit: objectId,
    head: objectId,
  }),
  machine: installation,
  commands: z.array(command).min(1).max(32),
  nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});
const requestSchema = z.strictObject({ challenge: challengeSchema, signature });
const receiptSchema = z.strictObject({
  signature,
  results: z
    .array(
      z.strictObject({
        head: objectId,
        tree: objectId,
        machine: installation,
        where: z.literal("container"),
        exitCode: z.number().int(),
        outputMatched: z.boolean(),
        startedAt: z.string().max(64),
        finishedAt: z.string().max(64),
      }),
    )
    .min(1)
    .max(32),
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  request: requestSchema,
  receipt: receiptSchema.nullable(),
});
const heavyGateBatchesSchema = z.record(
  batchIdSchema,
  z.strictObject({ machine: installation, commands: z.array(command).min(1).max(32) }),
);
const configSchema = z.object({
  schema: z.literal("vorteo-factory"),
  runners: z.object({ placement: z.literal("dev") }),
  version: z.literal(1),
  mode: z.literal("lean"),
  order: z.array(installation),
  lanes: z.strictObject({}).optional(),
  claimers: z.array(installation).optional(),
  machines: z.unknown(),
  heavyGateBatches: heavyGateBatchesSchema,
});

const optionalRecipes = z
  .object({
    runners: z.object({ placement: z.literal("dev") }),
    heavyGateBatches: heavyGateBatchesSchema.optional(),
  })
  .nullable();

export function configuredHeavyBatches(config: unknown) {
  const validated = optionalRecipes.safeParse(config);
  if (!validated.success) return null;
  return Object.entries(validated.data?.heavyGateBatches ?? {});
}

type Request = z.infer<typeof requestSchema>;
type Envelope = z.infer<typeof envelopeSchema>;
const maxEnvelopeBytes = 48 * 1024;

interface ExecutionRecord {
  expiresAt: number;
  digest: string;
  receipt: SignedHeavyGateReceipt | null;
}
interface ExecutionLedger extends LeanLedger {
  heavyGateExecutions?: Record<string, ExecutionRecord>;
}

function transportRolesKeys(
  roles: MachineRoles & { publicKeysFor?(id: string): readonly string[] },
  id: string,
): readonly string[] {
  if (roles.publicKeysFor) return roles.publicKeysFor(id);
  const key = roles.publicKeyFor(id);
  return key ? [key] : [];
}

function encode(envelope: Envelope): string | null {
  const body = JSON.stringify(envelope);
  return Buffer.byteLength(body) <= maxEnvelopeBytes ? body : null;
}

function decode(body: string): Envelope | null {
  if (Buffer.byteLength(body) > maxEnvelopeBytes) return null;
  try {
    const decoded = envelopeSchema.safeParse(JSON.parse(body));
    return decoded.success ? decoded.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export interface MachineBatchTransportOptions {
  github: FactoryGitHub;
  git: Omit<GitClaimStoreOptions, "namespace" | "repository">;
  repository: string;
  projectId: string;
  here: string;
  state: LeanStateStore;
  now(): number;
  environment: "host" | "container";
  /** daemon-owned active Host key path from machineSigningKeyPath(paseoHome) */
  keyPath: string;
  /** Verify the exact live PR head and current default-branch config from trusted GitHub facts. */
  readInputs(issue: number, head: string): Promise<Omit<IssueGateInputs, "commands"> | null>;
  /** Project mode, placement and local authority. Rechecked before command dispatch and acceptance. */
  authorizeBatch(batch: HeavyGateBatch): Promise<boolean>;
  /** Isolated, credential-free container executor, using only the pinned exact checkout. */
  execute(
    challenge: HeavyGateChallenge,
    command: IssueGateCommand,
    authorizeLaunch: () => Promise<boolean>,
  ): Promise<GateCommandExecution | null>;
}

export function createMachineBatchTransport(options: MachineBatchTransportOptions) {
  const refs = createGitClaimStore({
    ...options.git,
    repository: options.repository,
    namespace: "gate-batches",
  });
  return createBatchTransport(options, refs);
}

async function createBatchTransport(options: MachineBatchTransportOptions, refs: ClaimRefStore) {
  const { here, state, projectId, now } = options;
  const publishing = new Map<number, Promise<void>>();
  const running = new Set<string>();

  async function resolveConfigured(issue: number, head: string, batchId: string) {
    const input = await options.readInputs(issue, head);
    if (
      !input?.trusted ||
      input.issue !== issue ||
      input.repository !== options.repository ||
      input.head !== head ||
      input.protectedPaths.length ||
      !["passing", "absent"].includes(input.hostedChecks)
    )
      return null;

    const raw = await readPinnedFactoryConfig(
      options.github,
      options.repository,
      input.configCommit,
    );
    const config = configSchema.safeParse(raw);
    if (!config.success) return null;
    const recipe = Object.hasOwn(config.data.heavyGateBatches, batchId)
      ? config.data.heavyGateBatches[batchId]
      : null;
    const { roles } = resolveMachineRoles(config.data, here);
    if (
      !roles ||
      !recipe ||
      recipe.machine === roles.primary ||
      !transportRolesKeys(roles, roles.primary).length ||
      !transportRolesKeys(roles, recipe.machine).length
    )
      return null;

    const batch: HeavyGateBatch = {
      batchId,
      target: {
        repository: options.repository,
        issue,
        head,
        configCommit: input.configCommit,
        primary: roles.primary,
      },
      machine: recipe.machine,
      commands: recipe.commands,
    };
    return (await options.authorizeBatch(structuredClone(batch))) ? { batch, roles } : null;
  }

  async function resolve(batch: HeavyGateBatch): Promise<MachineRoles | null> {
    const configured = await resolveConfigured(
      batch.target.issue,
      batch.target.head,
      batch.batchId,
    );
    return configured && sameHeavyGateBatch(configured.batch, batch) ? configured.roles : null;
  }

  async function authenticate(request: Request): Promise<boolean> {
    const { challenge } = request;
    if (!isOpenHeavyGateChallenge(challenge, now())) return false;
    const roles = await resolve(challenge);
    return (
      roles !== null &&
      isOpenHeavyGateChallenge(challenge, now()) &&
      transportRolesKeys(roles, challenge.target.primary).some((pem) =>
        verifyMachinePayload(pem, heavyGateChallengeBytes(challenge), request.signature),
      )
    );
  }

  const resolveOwnerKey = async (batch: HeavyGateBatch) => {
    const roles = await resolve(batch);
    return roles ? transportRolesKeys(roles, batch.machine) : [];
  };

  async function signRequest(challenge: HeavyGateChallenge): Promise<Request | null> {
    const parsed = challengeSchema.safeParse(challenge);
    if (!parsed.success) return null;
    const roles = await resolve(challenge);
    if (!roles || here !== roles.primary || !isOpenHeavyGateChallenge(challenge, now()))
      return null;
    const key = await loadNativeHostSigningKey(options);
    const publicKey = createPublicKey(key);
    if (
      !transportRolesKeys(roles, here).some((pem) => readMachinePublicKey(pem)?.equals(publicKey))
    ) {
      return null;
    }
    return {
      challenge: parsed.data,
      signature: signMachinePayload(key, heavyGateChallengeBytes(challenge)),
    };
  }

  function verifierFor(primary: string) {
    return createHeavyGateVerifier({
      ...options,
      primary,
      resolveOwnerKey,
      oneChallengePerIssue: true,
    });
  }

  async function read(issue: number) {
    const snapshot = await refs.read(issue);
    return snapshot ? { revision: snapshot.revision, envelope: decode(snapshot.body) } : null;
  }

  async function reserve(challenge: HeavyGateChallenge) {
    const digest = createHash("sha256").update(heavyGateChallengeBytes(challenge)).digest("hex");
    return state.mutate(projectId, (ledger: ExecutionLedger) => {
      if (!isOpenHeavyGateChallenge(challenge, now())) return { kind: "expired" } as const;
      const records = (ledger.heavyGateExecutions ??= {});
      for (const [nonce, record] of Object.entries(records)) {
        if (now() >= record.expiresAt) delete records[nonce];
      }
      const existing = records[challenge.nonce];
      if (existing?.receipt && existing.digest === digest) {
        return { kind: "ready", receipt: existing.receipt } as const;
      }
      if (existing) return { kind: "interrupted" } as const;
      records[challenge.nonce] = { digest, receipt: null, expiresAt: challenge.expiresAt };
      return { kind: "execute", digest } as const;
    });
  }

  async function answer(request: Request, revision: string) {
    const { challenge } = request;
    if (running.has(challenge.nonce)) return null;
    running.add(challenge.nonce);
    try {
      return await executeRequest(request, revision);
    } finally {
      running.delete(challenge.nonce);
    }
  }

  async function executeRequest(request: Request, revision: string) {
    const { challenge } = request;
    const authorizeChallenge = async () =>
      (await authenticate(request)) &&
      (await refs.read(challenge.target.issue))?.revision === revision;
    if (!(await authorizeChallenge())) return null;

    const reserved = await reserve(challenge);
    if (reserved.kind === "expired") return null;
    if (reserved.kind === "ready") return reserved.receipt;
    if (reserved.kind === "interrupted") {
      throw new Error(
        "A heavy gate command may already have started. Wait for this challenge to expire before requesting another run.",
      );
    }
    let launchAuthorized = false;
    try {
      const run = await createNativeHeavyGateSigner({
        ...options,
        machine: here,
        resolveOwnerKey,
        authorizeChallenge,
        execute(boundChallenge, gateCommand, authorizeLaunch) {
          return options.execute(boundChallenge, gateCommand, async () => {
            const allowed = await authorizeLaunch();
            if (allowed) launchAuthorized = true;
            return allowed;
          });
        },
      });
      const receipt = await run(challenge);
      if (!receipt) return null;
      return await state.mutate(projectId, (ledger: ExecutionLedger) => {
        const record = ledger.heavyGateExecutions?.[challenge.nonce];
        if (!isOpenHeavyGateChallenge(challenge, now()) || record?.digest !== reserved.digest)
          return null;
        record.receipt = receipt;
        return receipt;
      });
    } finally {
      if (!launchAuthorized) {
        await state.mutate(projectId, (ledger: ExecutionLedger) => {
          const records = ledger.heavyGateExecutions;
          const record = records?.[challenge.nonce];
          if (records && record?.digest === reserved.digest && !record.receipt)
            delete records[challenge.nonce];
        });
      }
    }
  }

  async function publish(
    batch: HeavyGateBatch,
    lifetimeMs: number,
  ): Promise<HeavyGateChallenge | null> {
    const issue = batch.target.issue;
    const old = await read(issue);
    const verifier = verifierFor(here);
    const oldRequest = old?.envelope?.request;
    if (oldRequest?.challenge.target.issue === issue && (await authenticate(oldRequest))) {
      const previous = oldRequest.challenge;
      const slot = await verifier.slot(previous);
      if (slot && sameHeavyGateBatch(previous, batch)) return previous;
      if (slot === "pending") return null;
    }
    const challenge = await verifier.issue(batch, lifetimeMs);
    if (!challenge) return null;
    const request = await signRequest(challenge);
    const body = request && encode({ version: 1, request, receipt: null });
    if (!body || !isOpenHeavyGateChallenge(challenge, now())) return null;
    return (await refs.compareAndSwap(issue, old?.revision ?? null, body)) ? challenge : null;
  }

  const transport = {
    /** Advertise one challenge per issue. Serialize issuance against the primary's durable slot. */
    async request(batch: HeavyGateBatch, lifetimeMs: number): Promise<HeavyGateChallenge | null> {
      const expected = structuredClone(batch);
      if (here !== expected.target.primary || !(await resolve(expected))) return null;
      const issue = expected.target.issue;
      const previous = publishing.get(issue) ?? Promise.resolve();
      const issued = previous.then(() => publish(expected, lifetimeMs));
      const tail = issued.then(
        () => undefined,
        () => undefined,
      );
      publishing.set(issue, tail);
      try {
        return await issued;
      } finally {
        if (publishing.get(issue) === tail) publishing.delete(issue);
      }
    },
    /** On the selected native secondary, read, reserve, run, sign and conditionally respond. */
    async respond(issue: number): Promise<boolean> {
      const current = await read(issue);
      const envelope = current?.envelope;
      if (
        !current ||
        !envelope ||
        envelope.receipt ||
        envelope.request.challenge.target.issue !== issue ||
        envelope.request.challenge.machine !== here
      )
        return false;
      const { request } = envelope;
      const receipt = await answer(request, current.revision);
      const decoded = receiptSchema.safeParse(receipt);
      if (!decoded.success || !(await authenticate(request))) return false;
      const body = encode({ version: 1, request, receipt: decoded.data });
      return body !== null && (await refs.compareAndSwap(issue, current.revision, body));
    },
    /** Consume once, with an optional receipt write in the same primary ledger transaction. */
    async accept(
      expected: HeavyGateBatch,
      record?: (ledger: LeanLedger, results: readonly GateCommandExecution[]) => void,
    ): Promise<boolean> {
      if (here !== expected.target.primary) return false;
      const issue = expected.target.issue;
      const current = await read(issue);
      const envelope = current?.envelope;
      if (!current || !envelope?.receipt) return false;
      const { request, receipt } = envelope;
      if (!sameHeavyGateBatch(request.challenge, expected) || !(await authenticate(request)))
        return false;
      return verifierFor(here).accept(request.challenge, receipt, {
        record,
        beforeConsume: async () =>
          (await authenticate(request)) && (await refs.read(issue))?.revision === current.revision,
      });
    },
  };
  return {
    ...transport,
    /** Primary hook: derive the nominated machine and exact argv from owner configuration. */
    async requestConfigured(issue: number, head: string, batchId: string, lifetimeMs: number) {
      const configured = await resolveConfigured(issue, head, batchId);
      return configured ? transport.request(configured.batch, lifetimeMs) : null;
    },
    /** Primary hook: consume evidence only for the still-current configured batch. */
    async acceptConfigured(
      issue: number,
      head: string,
      batchId: string,
      record?: (ledger: LeanLedger, results: readonly GateCommandExecution[]) => void,
    ) {
      const configured = await resolveConfigured(issue, head, batchId);
      return configured ? transport.accept(configured.batch, record) : false;
    },
  };
}
