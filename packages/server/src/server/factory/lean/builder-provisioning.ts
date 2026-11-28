import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, realpath, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { BuilderPublicationOptions } from "./builder-runtime.js";

const provision = z.strictObject({
  version: z.literal(1),
  projectId: z.string().min(1).max(128),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  codexPath: z.string().refine(isAbsolute),
});
const projectKey = z.string().regex(/^[\w-]{1,128}$/u);
const managedProvision = z.strictObject({
  version: z.literal(1),
  placement: z.literal("host"),
  serverId: z.string().min(1).max(256),
  projectId: projectKey,
  repository: provision.shape.repository,
  provider: z.literal("codex"),
  path: provision.shape.codexPath,
});

/** Trusted by the daemon launcher, never accepted from a repository or an RPC caller. */
export interface ManagedPublisherHost {
  environment: "host" | "container";
  serverId: string;
}

/**
 * Resolve on each refresh. An owner can create or remove an exact private descriptor while
 * the daemon stays up. Managed installations never read the standalone scratch descriptor.
 */
export function createManagedHostBuilderPublication(input: {
  paseoHome: string;
  identity: ManagedPublisherHost | null;
}) {
  const uid = process.getuid?.();
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof createPublication>>>>();
  let closed = false;
  return {
    async forProject(
      projectId: string,
      repository: string,
      provider: string,
      placement: string | undefined,
    ) {
      if (
        closed ||
        input.identity?.environment !== "host" ||
        process.platform !== "darwin" ||
        uid === undefined ||
        placement !== "host" ||
        provider !== "codex"
      )
        return undefined;
      const fileProject = projectKey.parse(projectId);
      if (!isAbsolute(input.paseoHome))
        throw new Error("Host publication requires an absolute daemon home.");
      const home = await realpath(input.paseoHome).catch(absent);
      if (!home) return undefined;
      await requireDirectory(home, uid, 0o077);
      const factory = join(home, "factory");
      if (!(await lstat(factory).catch(absent))) return undefined;
      await requireDirectory(factory, uid, 0o022);
      const descriptors = join(factory, "lean-host-publishers");
      if (!(await lstat(descriptors).catch(absent))) return undefined;
      await requireDirectory(descriptors, uid, 0o077);
      const file = join(descriptors, `${fileProject}.codex.json`);
      const config = await readProvision(file, uid, managedProvision).catch(absent);
      if (
        !config ||
        config.projectId !== projectId ||
        config.repository.toLowerCase() !== repository.toLowerCase() ||
        config.serverId !== input.identity.serverId
      )
        return undefined;
      if (closed) return undefined;
      const key = JSON.stringify(config);
      let publisher = cache.get(key);
      if (!publisher) {
        publisher = createPublication(factory, file, config.path, uid).catch((error: unknown) => {
          cache.delete(key);
          throw error;
        });
        cache.set(key, publisher);
      }
      return (await publisher).options;
    },
    async close() {
      closed = true;
      await Promise.allSettled(
        [...cache.values()].map(async (publisher) => (await publisher).close()),
      );
      cache.clear();
    },
  };
}

/** Read once from the verified standalone daemon home, never from a checkout or GitHub. */
export async function loadStandaloneBuilderPublication(input: {
  paseoHome: string;
  standalone: boolean;
}): Promise<{
  forProject(projectId: string, repository: string): BuilderPublicationOptions | undefined;
  close(): Promise<void>;
} | null> {
  const uid = process.getuid?.();
  if (!input.standalone || process.platform !== "darwin" || uid === undefined) return null;
  if (!isAbsolute(input.paseoHome))
    throw new Error("Builder provisioning needs an absolute daemon home.");

  const home = await realpath(input.paseoHome).catch(absent);
  if (!home) return null;
  const factory = join(home, "factory");
  const file = join(factory, "lean-builder.json");
  const present = await lstat(file).catch(absent);
  if (!present) return null;
  if (!present.isFile()) throw new Error("Builder provisioning must be a private regular file.");
  await requireDirectory(home, uid, 0o022);
  await requireDirectory(factory, uid, 0o022);
  const config = await readProvision(file, uid, provision);
  const publisher = await createPublication(factory, file, config.codexPath, uid);
  return {
    forProject(projectId, repository) {
      if (projectId === config.projectId && repository === config.repository)
        return publisher.options;
      return undefined;
    },
    close: publisher.close,
  };
}

async function createPublication(factory: string, file: string, executable: string, uid: number) {
  const codexPath = await realpath(executable);
  const codex = await stat(codexPath);
  if (!codex.isFile() || (codex.uid !== uid && codex.uid !== 0) || (codex.mode & 0o022) !== 0)
    throw new Error("Builder provisioning needs a trusted native Codex executable.");
  await access(codexPath, constants.X_OK);

  const privateRoot = join(factory, "builder-publication");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await requireDirectory(privateRoot, uid, 0o077);
  const socketRoot = await mkdtemp("/private/tmp/fb-");
  const options: BuilderPublicationOptions = {
    privateRoot,
    socketRoot,
    codexPath,
    provisionFile: file,
  };
  return {
    options,
    async close() {
      try {
        await rmdir(socketRoot);
      } catch (error) {
        absent(error);
      }
    },
  };
}

async function requireDirectory(path: string, uid: number, deniedMode: number): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & deniedMode) !== 0)
    throw new Error("Builder provisioning storage has unsafe directory ownership or permissions.");
}

async function readProvision<T>(path: string, uid: number, schema: z.ZodType<T>): Promise<T> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const bytes = Buffer.alloc(4097);
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > 4096
    )
      throw new Error("Builder provisioning must be a bounded owner-only regular file.");
    const { bytesRead } = await handle.read(bytes);
    const current = await lstat(path);
    if (
      bytesRead !== info.size ||
      current.ino !== info.ino ||
      current.dev !== info.dev ||
      current.size !== info.size ||
      current.mtimeMs !== info.mtimeMs ||
      current.mode !== info.mode
    )
      throw new Error("Builder provisioning changed while the daemon was reading it.");
    return schema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await handle.close();
  }
}

function absent(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  return undefined;
}
