import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertNativeHostKeyEnvironment,
  assertPrivateMachineDirectory,
  loadNativeHostSigningKey,
  machineKeyFingerprint,
  machineSigningKeyPath,
} from "./host-key.js";
import { readFactoryHostHome, readFactoryHostServerId } from "./machine-identity-installation.js";

interface PublicMachineKey {
  fingerprint: string;
  publicKey: string;
}

export interface FactoryMachineIdentity {
  installation: string;
  active: PublicMachineKey | null;
  pending: PublicMachineKey | null;
}

type IdentityOperation =
  | { kind: "show" }
  | { kind: "generate" }
  | { kind: "stage" }
  | { kind: "activate"; fingerprint: string };

type VerifyOverlap = (identity: {
  installation: string;
  active: string;
  pending: string;
}) => Promise<boolean>;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function assertOutsideCheckout(home: string): Promise<void> {
  for (let directory = home; ; directory = dirname(directory)) {
    const git = await lstat(join(directory, ".git")).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (git) throw new Error("Factory key storage must be outside Git checkouts.");
    if (dirname(directory) === directory) return;
  }
}

async function readPublicKey(path: string): Promise<PublicMachineKey | null> {
  const privateKey = await loadNativeHostSigningKey({ environment: "host", keyPath: path }).catch(
    (error: unknown) => {
      if (missing(error)) return null;
      throw error;
    },
  );
  if (!privateKey) return null;
  const publicKey = createPublicKey(privateKey);
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    fingerprint: machineKeyFingerprint(publicKey),
  };
}

async function writeKey(path: string, key: KeyObject): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.pem`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(key.export({ type: "pkcs8", format: "pem" }));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function activateKey(
  identity: FactoryMachineIdentity,
  fingerprint: string,
  activePath: string,
  pendingPath: string,
  verifyOverlap: VerifyOverlap | undefined,
): Promise<void> {
  const { installation, active, pending } = identity;
  if (active?.fingerprint === fingerprint) return;
  if (!pending || pending.fingerprint !== fingerprint) {
    throw new Error("The fingerprint must match the staged Host key.");
  }
  if (
    !active ||
    !(await verifyOverlap?.({ installation, active: active.publicKey, pending: pending.publicKey }))
  ) {
    throw new Error(
      "Enroll both the active and staged Host keys in the current owner configuration before activation.",
    );
  }
  await rename(pendingPath, activePath);
}

/** Local owner operations for the installer-protected Host daemon home. */
export async function manageFactoryMachineIdentity(input: {
  environment: "host" | "container";
  paseoHome: string;
  projectId: string;
  expectedServerId: string;
  operation: IdentityOperation;
  verifyOverlap?: VerifyOverlap;
}): Promise<FactoryMachineIdentity> {
  const { paseoHome, projectId, operation } = input;
  const uid = await assertNativeHostKeyEnvironment(input.environment);
  if (!isAbsolute(paseoHome) || paseoHome !== resolve(paseoHome) || paseoHome === "/") {
    throw new Error("Factory identity requires the absolute native Host daemon home.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(projectId)) {
    throw new Error("Use the local Host Factory project ID.");
  }
  await assertPrivateMachineDirectory(paseoHome, uid);
  await assertOutsideCheckout(paseoHome);
  const root = dirname(dirname(paseoHome));
  const serverId = await readFactoryHostServerId(paseoHome);
  if ((await readFactoryHostHome(root)) !== paseoHome || serverId !== input.expectedServerId) {
    throw new Error("Factory requires the verified native Host installation.");
  }
  const installation = `${serverId}/${projectId}`;
  const activePath = machineSigningKeyPath(paseoHome, projectId);
  const directory = dirname(activePath);
  const identityRoot = dirname(directory);
  const pendingPath = join(directory, "pending.pem");
  const read = async () => ({
    installation,
    active: await readPublicKey(activePath),
    pending: await readPublicKey(pendingPath),
  });
  if (operation.kind === "show") return read();

  for (const path of [identityRoot, directory]) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await assertPrivateMachineDirectory(path, uid);
  }
  const lock = join(directory, "update.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error("Another Host key update is in progress or was interrupted.", { cause: error });
  }

  try {
    const { active, pending } = await read();
    if (operation.kind === "generate" && !active) {
      await writeKey(activePath, generateKeyPairSync("ed25519").privateKey);
    } else if (operation.kind === "stage") {
      if (!active) throw new Error("Generate the initial Host key before staging a replacement.");
      if (!pending) await writeKey(pendingPath, generateKeyPairSync("ed25519").privateKey);
    } else if (operation.kind === "activate") {
      await activateKey(
        { installation, active, pending },
        operation.fingerprint,
        activePath,
        pendingPath,
        input.verifyOverlap,
      );
    }

    await syncDirectory(directory);
    await syncDirectory(identityRoot);
    await syncDirectory(paseoHome);
    return read();
  } finally {
    await rmdir(lock);
  }
}
