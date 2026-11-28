import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  machineSigningKeyPath,
  nativeMachineSigningOptions,
  verifyMachinePayload,
} from "./host-key.js";
import { manageFactoryMachineIdentity } from "./machine-identity.js";
import { resolveInstalledFactoryHost } from "./machine-identity-installation.js";

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "factory-identity-"));
  home = join(root, "state", "host");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "installation.json"),
    JSON.stringify({ version: 1, root, hostHome: home }),
    { mode: 0o600 },
  );
  await writeFile(join(home, "server-id"), "srv_fixture\n", { mode: 0o600 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manage = (
  operation: Parameters<typeof manageFactoryMachineIdentity>[0]["operation"],
  overrides: Partial<Parameters<typeof manageFactoryMachineIdentity>[0]> = {},
) =>
  manageFactoryMachineIdentity({
    environment: "host",
    paseoHome: home,
    projectId: "project",
    expectedServerId: "srv_fixture",
    operation,
    allowsDevSigning: async () => true,
    ...overrides,
  });

describe("Host Factory identity", () => {
  it("resolves only the canonical Host home from the installed CLI's physical path", async () => {
    const source = join(root, "release", "machine.js");
    await mkdir(join(root, "release"));
    await writeFile(source, "");
    await expect(resolveInstalledFactoryHost(source)).resolves.toEqual({
      paseoHome: home,
      serverId: "srv_fixture",
    });
    await writeFile(
      join(root, "installation.json"),
      JSON.stringify({ version: 1, root, hostHome: join(root, "release") }),
    );
    await expect(resolveInstalledFactoryHost(source)).rejects.toThrow("canonical native Host");
  });

  it("shows without generating and atomically switches the active key after staging", async () => {
    expect(await manage({ kind: "show" })).toEqual({
      installation: "srv_fixture/project",
      active: null,
      pending: null,
    });
    const path = machineSigningKeyPath(home, "project");
    const hostProject = { allowsDevSigning: async () => false };
    await expect(manage({ kind: "generate" }, hostProject)).rejects.toThrow("Dev runner placement");
    expect(await manage({ kind: "show" }, hostProject)).toMatchObject({ signingDisabled: true });
    const clientFile = join(root, "host-agent.json");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await nativeMachineSigningOptions({ environment: "container" }, home, clientFile),
    ).toEqual({});
    expect(await nativeMachineSigningOptions({ environment: "host" }, root, clientFile)).toEqual(
      {},
    );
    const { machineSigner } = await nativeMachineSigningOptions(
      { environment: "host" },
      home,
      clientFile,
      async () => true,
    );
    if (!machineSigner) throw new Error("Expected the native Host signer.");
    const payload = Buffer.from("test machine payload");
    const sign = () => machineSigner("project", payload);
    await expect(sign()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manage({ kind: "stage" })).rejects.toThrow("Generate the initial");
    const initial = await manage({ kind: "generate" });
    expect(await manage({ kind: "generate" })).toEqual(initial);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const signature = await sign();
    const staged = await manage({ kind: "stage" });
    expect(staged.active).toEqual(initial.active);
    expect(staged.pending).not.toEqual(initial.active);
    expect(await manage({ kind: "stage" })).toEqual(staged);
    expect(await sign()).toBe(signature);
    await expect(manage({ kind: "activate", fingerprint: "0".repeat(64) })).rejects.toThrow(
      "must match",
    );
    expect(await manage({ kind: "show" })).toEqual(staged);
    const activation = { kind: "activate", fingerprint: staged.pending!.fingerprint } as const;
    await expect(manage(activation)).rejects.toThrow("Enroll both");
    await expect(manage(activation, { verifyOverlap: async () => false })).rejects.toThrow(
      "Enroll both",
    );
    expect(await manage({ kind: "show" })).toEqual(staged);
    const otherProject = await manage({ kind: "generate" }, { projectId: "other-project" });
    const activated = await manage(activation, {
      verifyOverlap: async (identity) =>
        identity.installation === staged.installation &&
        identity.active === staged.active?.publicKey &&
        identity.pending === staged.pending?.publicKey,
    });
    expect(activated).toEqual({
      installation: staged.installation,
      active: staged.pending,
      pending: null,
    });
    expect(await manage(activation)).toEqual(activated);
    expect(await manage({ kind: "show" }, { projectId: "other-project" })).toEqual(otherProject);
    expect(verifyMachinePayload(initial.active!.publicKey, payload, signature)).toBe(true);
    const nextSignature = await sign();
    expect(verifyMachinePayload(initial.active!.publicKey, payload, nextSignature)).toBe(false);
    expect(verifyMachinePayload(activated.active!.publicKey, payload, nextSignature)).toBe(true);
  });

  it("refuses symlinks, Git worktrees, guest execution and public Host state", async () => {
    const operation = { kind: "generate" } as const;
    await expect(manage(operation, { environment: "container" })).rejects.toThrow("native Host");
    const keyDirectory = join(home, "factory-machine-identity");
    await symlink(home, keyDirectory);
    await expect(manage(operation)).rejects.toThrow("private Host key directory");
    await writeFile(join(home, ".git"), "gitdir: /tmp/fixture");
    await expect(manage(operation)).rejects.toThrow("outside Git");
    await chmod(home, 0o755);
    await expect(manage(operation)).rejects.toThrow("private Host key directory");
  });

  it("fails closed for concurrent mutation and leaves read-only identity available", async () => {
    const initial = await manage({ kind: "generate" });
    const lock = join(home, "factory-machine-identity", "project", "update.lock");
    await mkdir(lock, { mode: 0o700 });
    await expect(manage({ kind: "stage" })).rejects.toThrow("in progress or was interrupted");
    expect(await manage({ kind: "show" })).toEqual(initial);
  });
});
