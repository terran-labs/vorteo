import { createHash, createPublicKey, randomBytes } from "node:crypto";
import {
  validGateCommand,
  validGateTarget,
  type GateCommandExecution,
  type GateTarget,
  type IssueGateCommand,
} from "../gate-receipts.js";
import type { LeanLedger, LeanStateStore } from "../types.js";
import {
  loadNativeHostSigningKey,
  readMachinePublicKey,
  signMachinePayload,
  verifyMachinePayload,
} from "./host-key.js";

export interface HeavyGateBatch {
  batchId: string;
  target: GateTarget;
  machine: string;
  commands: readonly IssueGateCommand[];
}

export interface HeavyGateChallenge extends HeavyGateBatch {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedHeavyGateReceipt {
  signature: string;
  results: GateCommandExecution[];
}

/** Resolve only the machine key from the current trusted owner recipe at target.configCommit.
 * The resolver also checks the pinned target, placement, and complete ordered batch recipe.
 */
type ResolveOwnerKey = (batch: HeavyGateBatch) => Promise<string | readonly string[] | null>;

function ownerKeys(resolved: Awaited<ReturnType<ResolveOwnerKey>>): readonly string[] {
  if (typeof resolved === "string") return [resolved];
  return resolved ?? [];
}

interface ChallengeLedger extends LeanLedger {
  heavyGateChallenges?: Record<string, { digest: string; expiresAt: number }>;
  heavyGateSlots?: Record<number, { nonce: string; digest: string; expiresAt: number }>;
}

const sha256 = /^[a-f0-9]{64}$/u;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const maxChallengeLifetimeMs = 24 * 60 * 60_000;

function validBatch(batch: HeavyGateBatch): boolean {
  return (
    batch != null &&
    typeof batch.batchId === "string" &&
    batch.batchId.length > 0 &&
    typeof batch.machine === "string" &&
    Boolean(batch.machine.trim()) &&
    batch.target != null &&
    typeof batch.target.primary === "string" &&
    typeof batch.target.repository === "string" &&
    typeof batch.target.head === "string" &&
    typeof batch.target.configCommit === "string" &&
    batch.machine !== batch.target.primary &&
    validGateTarget(batch.target) &&
    Array.isArray(batch.commands) &&
    batch.commands.length > 0 &&
    Array.from(batch.commands).every(
      (command: IssueGateCommand) =>
        command != null &&
        command.where === "container" &&
        Array.isArray(command.argv) &&
        Array.from(command.argv).every((arg) => typeof arg === "string") &&
        (command.requiredOutput === undefined || typeof command.requiredOutput === "string") &&
        validGateCommand(command),
    )
  );
}

export function isOpenHeavyGateChallenge(challenge: HeavyGateChallenge, now: number): boolean {
  return (
    validBatch(challenge) &&
    typeof challenge.nonce === "string" &&
    sha256.test(challenge.nonce) &&
    Number.isSafeInteger(challenge.issuedAt) &&
    Number.isSafeInteger(challenge.expiresAt) &&
    challenge.issuedAt <= now &&
    now < challenge.expiresAt &&
    challenge.expiresAt - challenge.issuedAt <= maxChallengeLifetimeMs
  );
}

function binding(challenge: HeavyGateChallenge) {
  const { target } = challenge;
  return [
    "vorteo.factory.heavy-gate.v1",
    challenge.nonce,
    challenge.batchId,
    target.repository,
    target.issue,
    target.primary,
    target.configCommit,
    target.head,
    challenge.machine,
    challenge.issuedAt,
    challenge.expiresAt,
    challenge.commands.map(({ argv, where, requiredOutput }) => [
      argv,
      where,
      requiredOutput ?? null,
    ]),
  ];
}

export function heavyGateChallengeBytes(challenge: HeavyGateChallenge): Buffer {
  return Buffer.from(JSON.stringify(["vorteo.factory.heavy-gate.request.v1", binding(challenge)]));
}

export function sameHeavyGateBatch(left: HeavyGateBatch, right: HeavyGateBatch): boolean {
  const batchBinding = (batch: HeavyGateBatch) =>
    JSON.stringify(binding({ ...batch, nonce: "", issuedAt: 0, expiresAt: 0 }));
  return batchBinding(left) === batchBinding(right);
}

function digest(challenge: HeavyGateChallenge): string {
  return createHash("sha256")
    .update(JSON.stringify(binding(challenge)))
    .digest("hex");
}

function payload(challenge: HeavyGateChallenge, results: readonly GateCommandExecution[]): Buffer {
  return Buffer.from(
    JSON.stringify([
      binding(challenge),
      results.map((result) => [
        result.head,
        result.machine,
        result.where,
        result.tree,
        result.exitCode,
        result.outputMatched,
        result.startedAt,
        result.finishedAt,
      ]),
    ]),
    "utf8",
  );
}

function passingResult(
  result: GateCommandExecution,
  challenge: HeavyGateChallenge,
  command: IssueGateCommand,
  earliest: number,
  now: number,
): boolean {
  return (
    result != null &&
    result.machine === challenge.machine &&
    result.head === challenge.target.head &&
    result.where === command.where &&
    typeof result.tree === "string" &&
    result.tree.length === result.head.length &&
    oid.test(result.tree) &&
    result.exitCode === 0 &&
    result.outputMatched === true &&
    typeof result.startedAt === "string" &&
    typeof result.finishedAt === "string" &&
    Date.parse(result.startedAt) >= earliest &&
    Date.parse(result.finishedAt) >= Date.parse(result.startedAt) &&
    Date.parse(result.finishedAt) <= now &&
    Date.parse(result.finishedAt) < challenge.expiresAt
  );
}

/** Construct inside the trusted native Host daemon. Wire execute to the disposable container
 * runner. Its boundary must not expose Host state or the signing key to checkout scripts.
 * The runner must invoke authorizeLaunch before launching each exact-checkout command.
 */
export async function createNativeHeavyGateSigner(input: {
  environment: "host" | "container";
  keyPath: string;
  machine: string;
  now(): number;
  resolveOwnerKey: ResolveOwnerKey;
  /** Authenticate the primary's request for this exact challenge before dispatch. */
  authorizeChallenge(challenge: HeavyGateChallenge): Promise<boolean>;
  execute(
    challenge: HeavyGateChallenge,
    command: IssueGateCommand,
    authorizeLaunch: () => Promise<boolean>,
  ): Promise<GateCommandExecution | null>;
}) {
  await loadNativeHostSigningKey(input);
  return async (request: HeavyGateChallenge): Promise<SignedHeavyGateReceipt | null> => {
    if (!isOpenHeavyGateChallenge(request, input.now())) return null;
    const challenge = structuredClone(request);
    async function authorized() {
      if (challenge.machine !== input.machine || !isOpenHeavyGateChallenge(challenge, input.now()))
        return false;
      if (!(await input.authorizeChallenge(structuredClone(challenge)))) return false;
      const keys = ownerKeys(await input.resolveOwnerKey(structuredClone(challenge)));
      const hostPublicKey = createPublicKey(await loadNativeHostSigningKey(input));
      return keys.some((pem) => readMachinePublicKey(pem)?.equals(hostPublicKey) === true);
    }

    if (!(await authorized())) return null;
    const results: GateCommandExecution[] = [];
    let earliest = challenge.issuedAt;
    for (const command of challenge.commands) {
      let launchAuthorized = false;
      const result = await input.execute(
        structuredClone(challenge),
        structuredClone(command),
        async () => {
          launchAuthorized = await authorized();
          return launchAuthorized;
        },
      );
      if (
        !launchAuthorized ||
        !result ||
        !passingResult(result, challenge, command, earliest, input.now())
      )
        return null;
      earliest = Date.parse(result.finishedAt);
      const { head, machine, where, tree, exitCode, outputMatched, startedAt, finishedAt } = result;
      results.push({ head, machine, where, tree, exitCode, outputMatched, startedAt, finishedAt });
    }
    if (!(await authorized())) return null;
    const key = await loadNativeHostSigningKey(input);
    const keys = ownerKeys(await input.resolveOwnerKey(structuredClone(challenge)));
    const local = createPublicKey(key);
    if (
      !keys.some((pem) => readMachinePublicKey(pem)?.equals(local) === true) ||
      !isOpenHeavyGateChallenge(challenge, input.now())
    )
      return null;
    return { signature: signMachinePayload(key, payload(challenge, results)), results };
  };
}

/** Construct on the static primary using its single daemon-owned state store. */
export function createHeavyGateVerifier(input: {
  projectId: string;
  primary: string;
  state: LeanStateStore;
  now(): number;
  resolveOwnerKey: ResolveOwnerKey;
  /** The Git transport permits only the most recently issued challenge for each issue. */
  oneChallengePerIssue?: boolean;
}) {
  const { state, projectId } = input;
  function isCurrent(
    ledger: ChallengeLedger,
    challenge: HeavyGateChallenge,
    expectedDigest: string,
  ) {
    const slot = ledger.heavyGateSlots?.[challenge.target.issue];
    return slot?.nonce === challenge.nonce && slot.digest === expectedDigest;
  }

  return {
    async slot(challenge: HeavyGateChallenge): Promise<"pending" | "consumed" | null> {
      const ledger: ChallengeLedger = await state.read(projectId);
      if (
        !isOpenHeavyGateChallenge(challenge, input.now()) ||
        !isCurrent(ledger, challenge, digest(challenge))
      )
        return null;
      return ledger.heavyGateChallenges?.[challenge.nonce] ? "pending" : "consumed";
    },

    async issue(batch: HeavyGateBatch, lifetimeMs: number): Promise<HeavyGateChallenge | null> {
      if (!validBatch(batch)) return null;
      const issuedAt = input.now();
      const challenge: HeavyGateChallenge = {
        ...structuredClone(batch),
        nonce: randomBytes(32).toString("hex"),
        issuedAt,
        expiresAt: issuedAt + lifetimeMs,
      };
      if (
        challenge.target.primary !== input.primary ||
        !isOpenHeavyGateChallenge(challenge, issuedAt)
      )
        return null;
      const keys = ownerKeys(await input.resolveOwnerKey(structuredClone(challenge)));
      if (!keys.some(readMachinePublicKey)) return null;
      return state.mutate(projectId, (ledger: ChallengeLedger) => {
        const now = input.now();
        if (!isOpenHeavyGateChallenge(challenge, now)) return null;
        const pending = (ledger.heavyGateChallenges ??= {});
        for (const [nonce, record] of Object.entries(pending)) {
          if (now >= record.expiresAt) delete pending[nonce];
        }
        const challengeDigest = digest(challenge);
        if (input.oneChallengePerIssue) {
          const slots = (ledger.heavyGateSlots ??= {});
          for (const [issue, slot] of Object.entries(slots)) {
            if (now >= slot.expiresAt) delete slots[Number(issue)];
          }
          const previous = slots[challenge.target.issue];
          if (previous) delete pending[previous.nonce];
          slots[challenge.target.issue] = {
            nonce: challenge.nonce,
            digest: challengeDigest,
            expiresAt: challenge.expiresAt,
          };
        }
        pending[challenge.nonce] = { digest: challengeDigest, expiresAt: challenge.expiresAt };
        return challenge;
      });
    },

    async accept(
      challenge: HeavyGateChallenge,
      receipt: SignedHeavyGateReceipt,
      options: {
        beforeConsume?: () => Promise<boolean>;
        record?: (ledger: LeanLedger, results: readonly GateCommandExecution[]) => void;
      } = {},
    ): Promise<boolean> {
      const now = input.now();
      if (!isOpenHeavyGateChallenge(challenge, now) || challenge.target.primary !== input.primary)
        return false;
      const expected = structuredClone(challenge);
      if (
        !receipt ||
        !Array.isArray(receipt.results) ||
        receipt.results.length !== expected.commands.length
      )
        return false;

      const { signature, results } = structuredClone(receipt);
      let earliest = expected.issuedAt;
      for (const [index, command] of expected.commands.entries()) {
        const result = results[index];
        if (!passingResult(result, expected, command, earliest, now)) return false;
        earliest = Date.parse(result.finishedAt);
      }

      const expectedDigest = digest(expected);
      const ledger: ChallengeLedger = await state.read(projectId);
      if (
        ledger.heavyGateChallenges?.[expected.nonce]?.digest !== expectedDigest ||
        (input.oneChallengePerIssue && !isCurrent(ledger, expected, expectedDigest))
      )
        return false;
      const keys = ownerKeys(await input.resolveOwnerKey(structuredClone(expected)));
      const signed = payload(expected, results);
      if (!keys.some((pem) => verifyMachinePayload(pem, signed, signature))) return false;
      if (options.beforeConsume && !(await options.beforeConsume())) return false;

      // Consume inside the ledger mutation so concurrent accepts and daemon restarts cannot replay it.
      return state.mutate(projectId, (current: ChallengeLedger) => {
        const pending = current.heavyGateChallenges;
        if (
          !isOpenHeavyGateChallenge(expected, input.now()) ||
          pending?.[expected.nonce]?.digest !== expectedDigest ||
          (input.oneChallengePerIssue && !isCurrent(current, expected, expectedDigest))
        )
          return false;
        options.record?.(current, results);
        delete pending[expected.nonce];
        return true;
      });
    },
  };
}
