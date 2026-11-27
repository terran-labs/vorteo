import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeanStateStore } from "../state.js";
import { loadNativeHostSigningKey, signMachinePayload } from "./host-key.js";
import {
  createHeavyGateVerifier,
  createNativeHeavyGateSigner,
  type HeavyGateBatch,
  type HeavyGateChallenge,
} from "./signed-gates.js";

const batch: HeavyGateBatch = {
  batchId: "batch-1",
  target: {
    repository: "owner/repo",
    issue: 1,
    primary: "primary",
    head: "a".repeat(40),
    configCommit: "b".repeat(40),
  },
  machine: "studio",
  commands: [
    { argv: ["npm", "test"], where: "container", requiredOutput: "passed" },
    { argv: ["npm", "run", "typecheck"], where: "container" },
  ],
};

describe("heavy gate receipts", () => {
  let home: string;
  let keyPath: string;
  let clock: number;
  let publicKey: string;

  beforeEach(async () => {
    vi.stubEnv("PASEO_NETWORK_MODE", undefined);
    home = await mkdtemp(join(await realpath(tmpdir()), "signed-gates-"));
    keyPath = join(home, "machine.pem");
    clock = Date.parse("2026-11-27T20:00:00.000Z");
    const keys = generateKeyPairSync("ed25519");
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function fixture() {
    const resolveOwnerKey = vi.fn(async () => publicKey as string | null);
    const verifierOptions = {
      projectId: "repo",
      primary: "primary",
      now: () => clock,
      resolveOwnerKey,
    };
    const verifier = createHeavyGateVerifier({
      ...verifierOptions,
      state: createLeanStateStore(home),
    });
    const execute = vi.fn<Parameters<typeof createNativeHeavyGateSigner>[0]["execute"]>(
      async (challenge, command, authorizeLaunch) => {
        if (!(await authorizeLaunch())) return null;
        const startedAt = new Date(clock).toISOString();
        clock += 1;
        return {
          head: challenge.target.head,
          machine: challenge.machine,
          where: command.where,
          tree: "c".repeat(40),
          exitCode: 0,
          outputMatched: true,
          startedAt,
          finishedAt: new Date(clock).toISOString(),
        };
      },
    );
    const sign = await createNativeHeavyGateSigner({
      environment: "host",
      keyPath,
      machine: "studio",
      now: () => clock,
      resolveOwnerKey,
      authorizeChallenge: async (request) => request.nonce === challenge?.nonce,
      execute,
    });
    const challenge = await verifier.issue(batch, 10_000);
    if (!challenge) throw new Error("Expected the primary to issue a challenge.");
    return { verifier, verifierOptions, execute, sign, challenge, resolveOwnerKey };
  }

  it("rejects forged outcomes and bindings without consuming the valid receipt", async () => {
    const { verifier, sign, challenge } = await fixture();
    const receipt = await sign(challenge);
    if (!receipt) throw new Error("Expected a receipt from the Host.");

    const forged = generateKeyPairSync("ed25519");
    expect(
      await verifier.accept(challenge, {
        ...receipt,
        signature: signMachinePayload(forged.privateKey, Buffer.from("fabricated result")),
      }),
    ).toBe(false);

    const tampered = structuredClone(receipt);
    tampered.results[0].tree = "d".repeat(40);
    expect(await verifier.accept(challenge, tampered)).toBe(false);
    const changedBindings: HeavyGateChallenge[] = [
      { ...challenge, batchId: "batch-2" },
      { ...challenge, machine: "another-studio" },
      { ...challenge, target: { ...challenge.target, head: "e".repeat(40) } },
      { ...challenge, target: { ...challenge.target, configCommit: "f".repeat(40) } },
      { ...challenge, commands: challenge.commands.toReversed() },
      {
        ...challenge,
        commands: [{ ...batch.commands[0], argv: ["npm", "run", "other"] }, batch.commands[1]],
      },
      { ...challenge, expiresAt: challenge.expiresAt + 100 },
    ];
    for (const changed of changedBindings) {
      expect(await verifier.accept(changed, receipt)).toBe(false);
    }

    const fresh = await verifier.issue(batch, 10_000);
    expect(fresh).not.toBeNull();
    expect(await verifier.accept(fresh!, receipt)).toBe(false);
    expect(await verifier.accept(challenge, receipt)).toBe(true);
  });

  it("consumes once across concurrent accepts and a fresh ledger reader", async () => {
    const { verifierOptions, sign, challenge } = await fixture();
    const receipt = await sign(challenge);
    if (!receipt) throw new Error("Expected a receipt from the Host.");
    const verifier = createHeavyGateVerifier({
      ...verifierOptions,
      state: createLeanStateStore(home),
    });
    const outcomes = await Promise.all([
      verifier.accept(challenge, receipt),
      verifier.accept(challenge, receipt),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    const restarted = createHeavyGateVerifier({
      ...verifierOptions,
      state: createLeanStateStore(home),
    });
    expect(await restarted.accept(challenge, receipt)).toBe(false);
  });

  it("rejects malformed challenges and Host commands before dispatch", async () => {
    const { verifier, sign, challenge, execute } = await fixture();
    const malformed = { ...challenge, commands: [{ argv: [42], where: "container" }] };
    expect(await sign(malformed as unknown as HeavyGateChallenge)).toBeNull();
    const hostBatch: HeavyGateChallenge = {
      ...challenge,
      commands: [{ argv: ["npm", "test"], where: "host" }],
    };
    expect(await verifier.issue(hostBatch, 10_000)).toBeNull();
    expect(await sign(hostBatch)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires launch authorization, a current owner key, and an unexpired challenge", async () => {
    const { verifier, execute, sign, challenge, resolveOwnerKey } = await fixture();
    const receipt = await sign(challenge);
    if (!receipt) throw new Error("Expected a receipt from the Host.");
    expect(await sign({ ...challenge, nonce: "0".repeat(64) })).toBeNull();
    execute.mockResolvedValueOnce(receipt.results[0]);
    expect(await sign(challenge)).toBeNull();
    resolveOwnerKey.mockResolvedValueOnce(null);
    expect(await verifier.accept(challenge, receipt)).toBe(false);
    clock = challenge.expiresAt;
    expect(await verifier.accept(challenge, receipt)).toBe(false);
    expect(await sign(challenge)).toBeNull();
  });

  it("loads the key only from a private regular native Host file", async () => {
    await expect(loadNativeHostSigningKey({ environment: "host", keyPath })).resolves.toMatchObject(
      {
        asymmetricKeyType: "ed25519",
      },
    );
    await expect(loadNativeHostSigningKey({ environment: "container", keyPath })).rejects.toThrow(
      "native Host",
    );
    const link = join(home, "symlink.pem");
    await symlink(keyPath, link);
    await expect(
      loadNativeHostSigningKey({ environment: "host", keyPath: link }),
    ).rejects.toThrow();
    await chmod(keyPath, 0o644);
    await expect(loadNativeHostSigningKey({ environment: "host", keyPath })).rejects.toThrow(
      "private Host key file",
    );
  });
});
