import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

async function ownerFile(path: string, byteLimit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.size > byteLimit
    ) {
      throw new Error("Factory requires protected native Host installation metadata.");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    (await realpath(path)) !== path
  ) {
    throw new Error("Factory requires private native Host installation state.");
  }
}

export async function readFactoryHostServerId(home: string): Promise<string> {
  const id = (await ownerFile(join(home, "server-id"), 1024)).trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
    throw new Error("Factory identity requires the existing Host daemon identity.");
  }
  return id;
}

/** Only the installer-owned home beneath this physical record directory is eligible. */
export async function readFactoryHostHome(root: string): Promise<string | null> {
  const recordText = await ownerFile(join(root, "installation.json"), 64 * 1024).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    },
  );
  if (recordText === null) return null;
  const record = JSON.parse(recordText) as {
    version?: number;
    root?: string;
    hostHome?: string;
  } | null;
  const stateDirectory = join(root, "state");
  const home = join(stateDirectory, "host");
  if (record?.version !== 1 || record.root !== root || record.hostHome !== home) {
    throw new Error("Factory requires the canonical native Host installation home.");
  }
  await privateDirectory(root);
  await privateDirectory(stateDirectory);
  await privateDirectory(home);
  return home;
}

/** Resolve from the physical installed CLI module path. Environment selectors do not choose state. */
export async function resolveInstalledFactoryHost(
  entry: string,
): Promise<{ paseoHome: string; serverId: string }> {
  if (!isAbsolute(entry))
    throw new Error("Run the Factory machine command from the installed Host CLI.");
  for (let root = dirname(await realpath(entry)); root !== dirname(root); root = dirname(root)) {
    const paseoHome =
      (await readFactoryHostHome(root)) ?? (await readFactoryHostHome(join(root, "host")));
    if (paseoHome) return { paseoHome, serverId: await readFactoryHostServerId(paseoHome) };
  }
  throw new Error("Run the Factory machine command from the installed Host CLI.");
}
