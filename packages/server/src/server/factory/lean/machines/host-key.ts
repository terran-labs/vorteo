import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/** The daemon supplies its own environment identity and a path in private, non-mounted Host state. */
export async function loadNativeHostSigningKey(input: {
  environment: "host" | "container";
  keyPath: string;
}): Promise<KeyObject> {
  const { keyPath } = input;
  const uid = process.getuid?.();
  if (
    input.environment !== "host" ||
    process.env.PASEO_NETWORK_MODE ||
    uid === undefined ||
    !isAbsolute(keyPath) ||
    resolve(keyPath) !== keyPath
  ) {
    throw new Error("Factory signing requires native Host key storage.");
  }

  const directory = dirname(keyPath);
  const parent = await lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error("Factory signing requires a private Host key directory.");
  }

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

export function readMachinePublicKey(pem: string): KeyObject | null {
  if (
    typeof pem !== "string" ||
    pem.length > 4096 ||
    !pem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !pem.trimEnd().endsWith("-----END PUBLIC KEY-----")
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
