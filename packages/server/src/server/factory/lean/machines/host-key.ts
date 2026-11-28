import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFactoryHostHome } from "./machine-identity-installation.js";

export function machineSigningKeyPath(paseoHome: string, projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(projectId)) {
    throw new Error("Use the local Host Factory project ID.");
  }
  return join(paseoHome, "factory-machine-identity", projectId, "active.pem");
}

async function noContainerMarker(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function canUseNativeHostKeys(): Promise<boolean> {
  return (
    typeof process.getuid === "function" &&
    !process.env.PASEO_NETWORK_MODE &&
    (await noContainerMarker("/.dockerenv")) &&
    (await noContainerMarker("/run/.containerenv"))
  );
}

export async function assertNativeHostKeyEnvironment(
  environment: "host" | "container",
): Promise<number> {
  if (environment !== "host" || !process.getuid || !(await canUseNativeHostKeys())) {
    throw new Error("Factory signing requires native Host key storage.");
  }
  return process.getuid();
}

export async function assertPrivateMachineDirectory(directory: string, uid: number): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== uid ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error("Factory signing requires a private Host key directory.");
  }
}

/** The daemon supplies its own environment identity and a path in private, non-mounted Host state. */
export async function loadNativeHostSigningKey(input: {
  environment: "host" | "container";
  keyPath: string;
}): Promise<KeyObject> {
  const { keyPath } = input;
  const uid = await assertNativeHostKeyEnvironment(input.environment);
  if (!isAbsolute(keyPath) || resolve(keyPath) !== keyPath) {
    throw new Error("Factory signing requires native Host key storage.");
  }

  await assertPrivateMachineDirectory(dirname(keyPath), uid);

  const file = await open(
    keyPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== uid ||
      (info.mode & 0o077) !== 0 ||
      info.nlink !== 1 ||
      info.size > 4096
    ) {
      throw new Error("Factory signing requires a private Host key file.");
    }
    const pem = await file.readFile();
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType === "ed25519") return key;
    } catch {
      // Keep key parser details out of daemon logs.
    } finally {
      pem.fill(0);
    }
    throw new Error("Factory signing requires an Ed25519 private key.");
  } finally {
    await file.close();
  }
}

export async function nativeMachineSigningOptions(
  installation: { environment: "host" | "container" } | null,
  paseoHome: string,
  clientConfigFile: string | undefined,
  allowsDevSigning?: (projectId: string) => Promise<boolean>,
): Promise<{ machineSigner?: (projectId: string, payload: Uint8Array) => Promise<string> }> {
  if (
    !allowsDevSigning ||
    installation?.environment !== "host" ||
    !clientConfigFile ||
    !(await canUseNativeHostKeys())
  )
    return {};
  const home = await readFactoryHostHome(dirname(clientConfigFile)).catch(() => null);
  if (paseoHome !== home) return {};
  return {
    async machineSigner(projectId, payload) {
      if (!(await allowsDevSigning(projectId)))
        throw new Error("Machine signing requires verified Dev runner placement.");
      const key = await loadNativeHostSigningKey({
        environment: "host",
        keyPath: machineSigningKeyPath(paseoHome, projectId),
      });
      return signMachinePayload(key, payload);
    },
  };
}

export function readMachinePublicKey(pem: string): KeyObject | null {
  if (
    typeof pem !== "string" ||
    pem.length > 4096 ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(pem)
  ) {
    return null;
  }
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export function machineKeyFingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export function signMachinePayload(key: KeyObject, payload: Uint8Array): string {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Factory signing requires an Ed25519 private key.");
  }
  return sign(null, payload, key).toString("base64");
}

export function verifyMachinePayload(
  publicKeyPem: string,
  payload: Uint8Array,
  signature: string,
): boolean {
  if (typeof signature !== "string" || signature.length !== 88) return false;
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== signature) return false;
  const key = readMachinePublicKey(publicKeyPem);
  return key !== null && verify(null, payload, key, bytes);
}
