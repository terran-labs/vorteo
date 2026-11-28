import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Command } from "commander";
import { factoryProjectGet, type ProjectFactoryState } from "@getpaseo/server/factory-project";
import { z } from "zod";

import { withOutput, type CommandOptions, type OutputSchema } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonOption, addLocalDaemonOptions } from "../../utils/command-options.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

const projectKey = z.string().regex(/^[\w-]{1,128}$/u);
const repositoryKey = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);
const descriptor = z.strictObject({
  version: z.literal(1),
  placement: z.literal("host"),
  serverId: z.string().min(1).max(256),
  projectId: projectKey,
  repository: repositoryKey,
  provider: z.literal("codex"),
  path: z.string().refine(isAbsolute),
});
type Descriptor = z.infer<typeof descriptor>;

export interface HostPublisherStatus {
  projectId: string;
  repository: string;
  provider: "codex";
  enabled: boolean;
  projectActive: boolean;
}

interface LocalIdentity {
  target: DaemonTarget;
  serverId: string;
  project: ProjectFactoryState;
}
type Action = "enable" | "disable";

function sameRepo(left: string | null, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function nativeProject(identity: LocalIdentity): boolean {
  const { project, serverId } = identity;
  return (
    project.serverId === serverId &&
    project.mode === "lean" &&
    (project.state === "on" || project.state === "paused") &&
    project.home?.environment === "host" &&
    project.home.here &&
    project.home.projectId === project.projectId
  );
}

function missing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  return undefined;
}

async function privateDirectory(path: string, uid: number, deniedMode: number, create: boolean) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  const info = await lstat(path).catch(missing);
  if (!info) return false;
  if (!info.isDirectory() || info.uid !== uid || info.mode & deniedMode)
    throw new Error(
      "Host publisher storage must be a protected native directory owned by this operator.",
    );
  return true;
}

async function descriptorPath(identity: LocalIdentity, create: boolean) {
  const uid = process.getuid?.();
  if (
    process.platform !== "darwin" ||
    uid === undefined ||
    identity.target.kind !== "instance" ||
    identity.project.serverId !== identity.serverId ||
    identity.project.home?.environment === "container"
  )
    return null;
  const home = await realpath(identity.target.home).catch(missing);
  if (!home || !(await privateDirectory(home, uid, 0o077, false))) return null;
  const factory = join(home, "factory");
  if (!(await privateDirectory(factory, uid, 0o022, create))) return null;
  const directory = join(factory, "lean-host-publishers");
  if (!(await privateDirectory(directory, uid, 0o077, create))) return null;
  return {
    uid,
    directory,
    file: join(directory, `${projectKey.parse(identity.project.projectId)}.codex.json`),
  };
}

async function readDescriptor(file: string, uid: number): Promise<Descriptor | null> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(missing);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.size > 4096
    )
      throw new Error("The existing Host publisher descriptor is not a private regular file.");
    const bytes = Buffer.alloc(4097);
    const read = await handle.read(bytes);
    if (read.bytesRead !== info.size)
      throw new Error("The Host publisher descriptor changed while being read.");
    return descriptor.parse(JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")));
  } finally {
    await handle.close();
  }
}

function matches(saved: Descriptor, identity: LocalIdentity, repository: string): boolean {
  return (
    saved.serverId === identity.serverId &&
    saved.projectId === identity.project.projectId &&
    sameRepo(saved.repository, repository)
  );
}

async function writeDescriptor(directory: string, file: string, value: Descriptor) {
  const temporary = await mkdtemp(join(directory, ".write-"));
  const source = join(temporary, "descriptor.json");
  try {
    const handle = await open(source, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(source, file);
  } finally {
    await unlink(source).catch(missing);
    await rmdir(temporary);
  }
}

async function executable(path: string | undefined, uid: number) {
  if (!path || !isAbsolute(path))
    throw new Error("Pass an absolute native Codex executable with --path.");
  const resolved = await realpath(path);
  const info = await stat(resolved);
  if (!info.isFile() || (info.uid !== uid && info.uid !== 0) || info.mode & 0o022)
    throw new Error("The Codex executable must be a trusted native file.");
  await access(resolved, constants.X_OK);
  return resolved;
}

function status(
  identity: LocalIdentity,
  repository: string,
  enabled: boolean,
): HostPublisherStatus {
  return {
    projectId: identity.project.projectId,
    repository,
    provider: "codex",
    enabled,
    projectActive: nativeProject(identity) && identity.project.state === "on",
  };
}

/** Local read only. A registered descriptor can remain configured while its project is off. */
export async function readHostPublisherStatus(
  identity: LocalIdentity,
): Promise<HostPublisherStatus | undefined> {
  const repository = identity.project.repository;
  if (
    !repository ||
    identity.target.kind !== "instance" ||
    process.platform !== "darwin" ||
    identity.project.home?.environment === "container"
  )
    return undefined;
  const target = await descriptorPath(identity, false);
  const saved = target ? await readDescriptor(target.file, target.uid) : null;
  if (!saved && identity.project.home?.environment !== "host") return undefined;
  return status(identity, repository, Boolean(saved && matches(saved, identity, repository)));
}

export async function configureHostPublisher(
  identity: LocalIdentity,
  input: { action: Action; projectId: string; repository: string; provider: string; path?: string },
): Promise<HostPublisherStatus> {
  if (input.provider !== "codex")
    throw new Error(`Host publication does not support provider "${input.provider}". Use codex.`);
  const projectId = projectKey.parse(input.projectId);
  const repository = repositoryKey.parse(input.repository);
  if (
    identity.project.projectId !== projectId ||
    identity.project.serverId !== identity.serverId ||
    !sameRepo(identity.project.repository, repository)
  )
    throw new Error("The repository and project must match the registration on this daemon.");
  const activating = input.action === "enable";
  if (activating && !nativeProject(identity))
    throw new Error(
      "Enable publication only on the registered Lean project that owns the managed native Host binding.",
    );
  const target = await descriptorPath(identity, activating);
  if (!target) {
    if (
      !activating &&
      identity.target.kind === "instance" &&
      identity.project.home?.environment === "host"
    )
      return status(identity, repository, false);
    throw new Error("Host publisher configuration requires the protected local native Host.");
  }
  const saved = await readDescriptor(target.file, target.uid);
  if (saved && !matches(saved, identity, repository))
    throw new Error("The target descriptor belongs to a different Host, project or repository.");
  if (!activating) {
    if (saved) await unlink(target.file).catch(missing);
    return status(identity, repository, false);
  }
  const registered = descriptor.parse({
    version: 1,
    placement: "host",
    serverId: identity.serverId,
    projectId,
    repository,
    provider: "codex",
    path: await executable(input.path, target.uid),
  });
  if (saved) {
    if (saved.path !== registered.path)
      throw new Error(
        "This publisher is already configured with another executable. Disable that exact entry first.",
      );
  } else {
    await writeDescriptor(target.directory, target.file, registered).catch(
      async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const concurrent = await readDescriptor(target.file, target.uid);
        if (
          !concurrent ||
          !matches(concurrent, identity, repository) ||
          concurrent.path !== registered.path
        )
          throw new Error("The publisher entry changed. Inspect it before trying again.");
      },
    );
  }
  return status(identity, repository, true);
}

const publisherSchema: OutputSchema<HostPublisherStatus> = {
  idField: "projectId",
  columns: [],
  renderHuman(result) {
    const value = result.data as HostPublisherStatus;
    return `Host publisher ${value.enabled ? "enabled" : "disabled"} for ${value.repository} (${value.provider}).`;
  },
};

export function createHostPublisherCommand(action: Action): Command {
  const command = addLocalDaemonOptions(
    addJsonOption(
      new Command(`${action}-host-publisher`)
        .description(
          `${action === "enable" ? "Enable" : "Disable"} a managed Host Builder publisher`,
        )
        .argument("<project>", "Exact registered project identity")
        .requiredOption("--repository <owner/repo>", "Exact registered repository")
        .requiredOption("--provider <name>", "Builder provider type")
        .allowExcessArguments(false),
    ),
  );
  if (action === "enable")
    command.requiredOption("--path <absolute>", "Trusted native provider executable");
  return command.action(
    withOutput(async (projectId: string, options: CommandOptions, _command: Command) => {
      if (process.platform !== "darwin" || options.daemonTarget.kind !== "instance")
        throw new Error("Run this command on the local managed native Host.");
      const client = await connectToDaemon({ target: options.daemonTarget });
      try {
        const serverId = client.getLastServerInfoMessage()?.serverId;
        if (!serverId) throw new Error("The native daemon did not identify itself.");
        const project = factoryProjectGet.output.parse(
          await client.invokePluginRpc("factory", factoryProjectGet.name, { projectId }),
        );
        const data = await configureHostPublisher(
          { target: options.daemonTarget, serverId, project },
          {
            action,
            projectId,
            repository: String(options.repository),
            provider: String(options.provider),
            path: typeof options.path === "string" ? options.path : undefined,
          },
        );
        return { type: "single" as const, data, schema: publisherSchema };
      } finally {
        await client.close().catch(() => undefined);
      }
    }),
  );
}
