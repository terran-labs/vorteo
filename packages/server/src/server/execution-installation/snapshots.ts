import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import {
  InstallationSnapshotSchema,
  SnapshotPartKindSchema,
  type InstallationSnapshot,
  type SnapshotPart,
  type SnapshotPartKind,
} from "@getpaseo/protocol/installation-upgrades";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import type { InstallationConfig } from "./config.js";
import type { ManagedService, ServiceControl } from "./service-control.js";

export const SNAPSHOT_RETENTION = 5;

/** Path segments never copied: package caches rebuild themselves and can be gigabytes. */
export const SNAPSHOT_EXCLUDED_NAMES: readonly string[] = [".npm", ".cache", ".pnpm-store"];

/** Top-level entries of Dev's deployment directory that belong to other parts or none. */
const DEPLOYMENT_EXCLUDED_ENTRIES = new Set(["data", "workspace", "logs"]);

export const SnapshotSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("directory"),
    kind: SnapshotPartKindSchema,
    path: z.string().startsWith("/"),
    /** Top-level entry names left out, beside SNAPSHOT_EXCLUDED_NAMES anywhere. */
    excludeTopLevel: z.array(z.string()).optional(),
  }),
  z.strictObject({
    type: z.literal("file"),
    kind: SnapshotPartKindSchema,
    path: z.string().startsWith("/"),
  }),
  z.strictObject({
    type: z.literal("docker"),
    kind: z.literal("dev-home"),
    docker: z.string().startsWith("/"),
    container: z.string().min(1),
    path: z.string().startsWith("/"),
    /**
     * The path is a bind mount of the Host (Linux Dev's home). A restore then replaces
     * its contents as root through Dev's own mounts, and puts them back on failure.
     */
    mounted: z.literal(true).optional(),
  }),
]);
export type SnapshotSource = z.infer<typeof SnapshotSourceSchema>;

/** Where snapshots live: `<installRoot>/state/snapshots`, or null before the one-command installer. */
export function snapshotRoot(config: Pick<InstallationConfig, "deployment">): string | null {
  const root = config.deployment?.installRoot;
  return root ? path.join(root, "state", "snapshots") : null;
}

/** Everything a snapshot captures for this installation, in restore order. */
export function snapshotSources(
  config: InstallationConfig,
  configFile: string,
  exists: (file: string) => boolean = existsSync,
): SnapshotSource[] {
  const sources: SnapshotSource[] = [
    { type: "directory", kind: "coordinator-state", path: config.stateDir },
    { type: "file", kind: "deployment", path: configFile },
  ];
  const hostHome = config.deployment?.hostHome ?? config.host.startupValidation?.home;
  if (hostHome) sources.push({ type: "directory", kind: "host-home", path: hostHome });
  if (!config.container) return sources;
  // A Dev the installer does not manage (an adopted installation without containerDirectory)
  // is neither captured nor restored; snapshots cover the Host only.
  if (config.deployment && !config.deployment.containerDirectory) return sources;
  const directory = config.deployment?.containerDirectory;
  const boundHome =
    config.deployment?.containerHome ??
    (directory && exists(path.join(directory, "data/home"))
      ? path.join(directory, "data/home")
      : undefined);
  const container = config.containerSourceUpdates;
  if (boundHome) sources.push({ type: "directory", kind: "dev-home", path: boundHome });
  else if (container)
    sources.push({
      type: "docker",
      kind: "dev-home",
      docker: container.docker,
      container: container.containerId,
      path: container.home,
    });
  if (directory)
    sources.push({
      type: "directory",
      kind: "deployment",
      path: directory,
      excludeTopLevel: [...DEPLOYMENT_EXCLUDED_ENTRIES],
    });
  return sources;
}

/** Where Dev's home is mounted inside its container (docker/multiplex compose files). */
const DEV_HOME_IN_CONTAINER = "/home/paseo";

/** The Compose container that runs Dev, named by the deployment's PASEO_INSTANCE. */
export function devContainerName(directory: string | undefined): string | null {
  if (!directory) return null;
  try {
    const line = readFileSync(path.join(directory, ".env"), "utf8")
      .split("\n")
      .find((item) => item.startsWith("PASEO_INSTANCE="));
    const instance = line?.slice("PASEO_INSTANCE=".length).trim();
    return instance ? `${instance}-paseo-1` : null;
  } catch {
    return null;
  }
}

/**
 * On Linux, Dev's bind-mounted home belongs to the container's user with private modes,
 * so the Host cannot read it. Its snapshot part goes through the running container
 * instead, and a restore replaces it through Dev's mounts (`mountedHomeRestore`). Docker Desktop on
 * macOS shows the files as the Host user's, so the folder is copied there as before.
 */
export function devHomeThroughContainer(
  sources: SnapshotSource[],
  input: { platform: NodeJS.Platform; docker: string | null; container: string | null },
): SnapshotSource[] {
  const { platform, docker, container } = input;
  if (platform !== "linux" || !docker || !container) return sources;
  return sources.map((source) =>
    source.type === "directory" && source.kind === "dev-home"
      ? {
          type: "docker",
          kind: "dev-home",
          docker,
          container,
          path: DEV_HOME_IN_CONTAINER,
          mounted: true,
        }
      : source,
  );
}

/** An absolute docker executable on PATH or in its usual places, or null. */
export function findDocker(searchPath = process.env.PATH ?? ""): string | null {
  const candidates = [
    ...searchPath
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "docker")),
    "/usr/bin/docker",
    "/usr/local/bin/docker",
  ];
  return candidates.find((file) => path.isAbsolute(file) && existsSync(file)) ?? null;
}

export function sourceLabel(source: SnapshotSource): string {
  return source.type === "docker" ? `docker:${source.container}:${source.path}` : source.path;
}

/** Sortable directory name: 20261030T120000123Z. */
export function snapshotIdFor(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export interface SnapshotPorts {
  now(): Date;
  /** Streams `tar` of a path inside Dev to a file, leaving out caches. */
  exportDocker(source: Extract<SnapshotSource, { type: "docker" }>, file: string): Promise<void>;
  /** Unpacks a tar file over a path inside Dev; works while the container is stopped. */
  importDocker(source: Extract<SnapshotSource, { type: "docker" }>, file: string): Promise<void>;
}

interface Counted {
  files: number;
  bytes: number;
}

function excluded(name: string): boolean {
  return SNAPSHOT_EXCLUDED_NAMES.includes(name);
}

/** Copies regular files, directories and symlinks; skips sockets, FIFOs and caches. */
function copyTree(
  source: string,
  destination: string,
  excludeTopLevel: readonly string[] = [],
  skip: readonly string[] = [],
): Counted {
  const counted: Counted = { files: 0, bytes: 0 };
  cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    filter(entry) {
      if (skip.some((root) => entry === root || entry.startsWith(root + path.sep))) return false;
      const relative = path.relative(source, entry);
      if (relative && !relative.includes(path.sep) && excludeTopLevel.includes(relative))
        return false;
      if (relative.split(path.sep).some(excluded)) return false;
      const stat = lstatSync(entry);
      if (stat.isFile()) {
        counted.files += 1;
        counted.bytes += stat.size;
        return true;
      }
      return stat.isDirectory() || stat.isSymbolicLink();
    },
  });
  return counted;
}

function partDirectory(index: number, kind: SnapshotPartKind): string {
  return `${String(index).padStart(2, "0")}-${kind}`;
}

export interface InstallationSnapshots {
  readonly root: string;
  list(): InstallationSnapshot[];
  read(id: string): InstallationSnapshot;
  take(input: {
    reason: InstallationSnapshot["reason"];
    upgradeId?: string;
    release?: string;
  }): Promise<InstallationSnapshot>;
  /** Removes the oldest snapshots beyond retention, never one named in `keep`. */
  prune(keep?: readonly string[]): string[];
  /** Stored copy of each part, in snapshot order. */
  storedParts(snapshot: InstallationSnapshot): StoredPart[];
}

export interface StoredPart {
  part: SnapshotPart;
  source: SnapshotSource;
  stored: string;
}

const StoredSourcesSchema = z.array(SnapshotSourceSchema);

export function createInstallationSnapshots(input: {
  root: string;
  sources: () => SnapshotSource[];
  ports: SnapshotPorts;
  retention?: number;
}): InstallationSnapshots {
  const { root, ports } = input;
  const retention = input.retention ?? SNAPSHOT_RETENTION;

  function list(): InstallationSnapshot[] {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter(
        (name) =>
          !name.startsWith(".") && InstallationSnapshotSchema.shape.id.safeParse(name).success,
      )
      .flatMap((name) => {
        try {
          return [read(name)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  function read(id: string): InstallationSnapshot {
    InstallationSnapshotSchema.shape.id.parse(id);
    return InstallationSnapshotSchema.parse(
      JSON.parse(readFileSync(path.join(root, id, "manifest.json"), "utf8")),
    );
  }

  function uniqueId(): string {
    const base = snapshotIdFor(ports.now());
    let id = base;
    for (let suffix = 2; existsSync(path.join(root, id)); suffix += 1) id = `${base}-${suffix}`;
    return id;
  }

  async function capture(source: SnapshotSource, destination: string): Promise<Counted> {
    if (source.type === "docker") {
      const file = `${destination}.tar`;
      await ports.exportDocker(source, file);
      return { files: 1, bytes: statSync(file).size };
    }
    if (source.type === "file") {
      ensurePrivateDirectory(destination);
      return copyTree(source.path, path.join(destination, path.basename(source.path)));
    }
    // A snapshot root inside a captured directory would copy earlier snapshots.
    return copyTree(source.path, destination, source.excludeTopLevel, [root]);
  }

  return {
    root,
    list,
    read,
    async take({ reason, upgradeId, release }) {
      ensurePrivateDirectory(root);
      for (const name of readdirSync(root))
        if (name.startsWith(".") && name.endsWith(".partial"))
          rmSync(path.join(root, name), { recursive: true, force: true });
      const id = uniqueId();
      const partial = path.join(root, `.${id}.partial`);
      ensurePrivateDirectory(path.join(partial, "parts"));
      const sources = input
        .sources()
        .filter((source) => source.type === "docker" || existsSync(source.path));
      const parts: SnapshotPart[] = [];
      try {
        for (const [index, source] of sources.entries()) {
          const counted = await capture(
            source,
            path.join(partial, "parts", partDirectory(index, source.kind)),
          );
          parts.push({ kind: source.kind, source: sourceLabel(source), ...counted });
        }
        const snapshot = InstallationSnapshotSchema.parse({
          version: 1,
          id,
          createdAt: ports.now().toISOString(),
          reason,
          ...(upgradeId ? { upgradeId } : {}),
          ...(release ? { release } : {}),
          parts,
        });
        writePrivateFileAtomicSync(path.join(partial, "sources.json"), JSON.stringify(sources));
        writePrivateFileAtomicSync(
          path.join(partial, "manifest.json"),
          JSON.stringify(snapshot, null, 2),
        );
        renameSync(partial, path.join(root, id));
        return snapshot;
      } catch (error) {
        rmSync(partial, { recursive: true, force: true });
        throw error;
      }
    },
    prune(keep = []) {
      const removed: string[] = [];
      for (const snapshot of list().slice(retention)) {
        if (keep.includes(snapshot.id)) continue;
        rmSync(path.join(root, snapshot.id), { recursive: true, force: true });
        removed.push(snapshot.id);
      }
      return removed;
    },
    storedParts(snapshot) {
      const sources = StoredSourcesSchema.parse(
        JSON.parse(readFileSync(path.join(root, snapshot.id, "sources.json"), "utf8")),
      );
      if (sources.length !== snapshot.parts.length)
        throw new Error("Snapshot manifest and sources differ");
      return snapshot.parts.map((part, index) => {
        const source = sources[index];
        if (source.kind !== part.kind || sourceLabel(source) !== part.source)
          throw new Error("Snapshot manifest and sources differ");
        const directory = path.join(root, snapshot.id, "parts", partDirectory(index, part.kind));
        return { part, source, stored: source.type === "docker" ? `${directory}.tar` : directory };
      });
    },
  };
}

/** Kinds a restore replaces, sorted and without repeats, for exact confirmation. */
export function snapshotPartKinds(snapshot: InstallationSnapshot): SnapshotPartKind[] {
  return [...new Set(snapshot.parts.map((part) => part.kind))].sort();
}

export type RestoreStep =
  | { action: "stop" | "start"; service: ManagedService }
  | { action: "restore"; index: number }
  | { action: "verify-coordinator" };

/**
 * Restore order: stop the coordinator first so it cannot rewrite its journals, then
 * the Host daemon and Dev; replace every part; start Dev and the Host before the
 * coordinator, which binds both daemons when it starts.
 */
export function planRestore(parts: readonly StoredPart[], hasDev: boolean): RestoreStep[] {
  const services: ManagedService[] = hasDev
    ? ["coordinator", "host", "dev"]
    : ["coordinator", "host"];
  return [
    ...services.map((service) => ({ action: "stop" as const, service })),
    ...parts.map((_part, index) => ({ action: "restore" as const, index })),
    ...services.toReversed().map((service) => ({ action: "start" as const, service })),
    { action: "verify-coordinator" },
  ];
}

type DockerSource = Extract<SnapshotSource, { type: "docker" }>;

/**
 * Replaces a bind-mounted Dev home from a snapshot: its current contents move aside within
 * the same mount, the snapshot unpacks with its owners, and the aside copy is put back
 * after a failure or discarded once the whole restore succeeds.
 */
export interface MountedHomeRestore {
  replace(source: DockerSource, file: string, restoreId: string): Promise<void>;
  revert(source: DockerSource, restoreId: string): Promise<void>;
  discard(source: DockerSource, restoreId: string): Promise<void>;
}

export interface RestorePorts {
  services: ServiceControl;
  snapshot: Pick<SnapshotPorts, "importDocker"> & { mounted?: MountedHomeRestore };
  verifyCoordinator(): Promise<void>;
  progress(step: string): void;
}

function asideName(target: string, restoreId: string): string {
  return `${target}.before-restore-${restoreId}`;
}

/** Replaces one part. The current copy moves aside until the whole restore succeeds. */
async function restorePart(
  part: StoredPart,
  restoreId: string,
  ports: RestorePorts,
): Promise<void> {
  const { source, stored } = part;
  if (source.type === "docker") {
    if (source.mounted && ports.snapshot.mounted)
      await ports.snapshot.mounted.replace(source, stored, restoreId);
    else await ports.snapshot.importDocker(source, stored);
    return;
  }
  if (source.type === "file") {
    const aside = asideName(source.path, restoreId);
    if (existsSync(source.path)) renameSync(source.path, aside);
    copyTree(path.join(stored, path.basename(source.path)), source.path);
    return;
  }
  const aside = asideName(source.path, restoreId);
  if (!source.excludeTopLevel?.length) {
    if (existsSync(source.path)) renameSync(source.path, aside);
    copyTree(stored, source.path);
    return;
  }
  // Dev's deployment directory also holds Dev's home and workspace; replace only
  // the captured entries and leave the excluded ones in place.
  ensurePrivateDirectory(aside);
  for (const name of readdirSync(source.path)) {
    if (source.excludeTopLevel.includes(name)) continue;
    renameSync(path.join(source.path, name), path.join(aside, name));
  }
  for (const name of readdirSync(stored))
    copyTree(path.join(stored, name), path.join(source.path, name));
}

/** Puts a moved-aside part back after a failed restore. */
async function revertPart(part: StoredPart, restoreId: string, ports: RestorePorts) {
  const { source } = part;
  if (source.type === "docker") {
    if (source.mounted) await ports.snapshot.mounted?.revert(source, restoreId);
    return;
  }
  const aside = asideName(source.path, restoreId);
  if (!existsSync(aside)) return;
  if (source.type === "directory" && source.excludeTopLevel?.length) {
    for (const name of readdirSync(source.path))
      if (!source.excludeTopLevel.includes(name))
        rmSync(path.join(source.path, name), { recursive: true, force: true });
    for (const name of readdirSync(aside))
      renameSync(path.join(aside, name), path.join(source.path, name));
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  rmSync(source.path, { recursive: true, force: true });
  renameSync(aside, source.path);
}

async function discardAside(part: StoredPart, restoreId: string, ports: RestorePorts) {
  if (part.source.type === "docker") {
    if (part.source.mounted) await ports.snapshot.mounted?.discard(part.source, restoreId);
    return;
  }
  rmSync(asideName(part.source.path, restoreId), { recursive: true, force: true });
}

/**
 * Runs a restore plan. On any failure it puts back every part it replaced, starts
 * the stopped services again and rethrows, so the installation returns to the state
 * the owner left. A separate pre-restore snapshot keeps that state restorable too.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A restore failed and some replaced parts could not be put back. Their previous copies
 * stay beside them (`*.before-restore-<id>`), so the installation needs recovery by hand.
 */
export class RestoreRollbackError extends Error {
  constructor(
    readonly restoreError: unknown,
    readonly problems: readonly string[],
  ) {
    const reason = restoreError instanceof Error ? restoreError.message : String(restoreError);
    super(
      `Restore failed (${reason}) and putting things back failed: ${problems.join("; ")}. The services stay stopped, and the previous copies are kept beside each part as .before-restore-<id>; recover them before starting the installation again.`,
    );
    this.name = "RestoreRollbackError";
  }
}

export async function executeRestore(input: {
  restoreId: string;
  parts: readonly StoredPart[];
  steps: readonly RestoreStep[];
  ports: RestorePorts;
}): Promise<void> {
  const { restoreId, parts, steps, ports } = input;
  const replaced: StoredPart[] = [];
  const stopped: ManagedService[] = [];
  const everStopped: ManagedService[] = [];
  // Recorded before each start is awaited: a start that fails, such as Dev failing its
  // health wait, may still have launched the service.
  const started = new Set<ManagedService>();
  try {
    for (const step of steps) {
      ports.progress(describeStep(step, parts));
      if (step.action === "stop") {
        await ports.services.stop(step.service);
        stopped.push(step.service);
        everStopped.push(step.service);
      } else if (step.action === "start") {
        started.add(step.service);
        await ports.services.start(step.service);
        stopped.splice(stopped.indexOf(step.service), 1);
      } else if (step.action === "restore") {
        const part = parts[step.index];
        replaced.push(part);
        await restorePart(part, restoreId, ports);
      } else await ports.verifyCoordinator();
    }
  } catch (error) {
    ports.progress("Restore failed; putting back the replaced files");
    // Files change only once every service the plan may have started is stopped again,
    // coordinator first as the plan does. A service that will not stop leaves the
    // restored files and the previous copies as they are.
    const problems: string[] = [];
    for (const service of everStopped.filter((item) => started.has(item)))
      await ports.services
        .stop(service)
        .catch((stopError: unknown) =>
          problems.push(`stopping ${service}: ${describeError(stopError)}`),
        );
    if (problems.length) throw new RestoreRollbackError(error, problems);
    for (const part of replaced.toReversed())
      await revertPart(part, restoreId, ports).catch((revertError: unknown) =>
        problems.push(`${part.part.source}: ${describeError(revertError)}`),
      );
    // Partially recovered data must not start; the owner recovers it first.
    if (problems.length) throw new RestoreRollbackError(error, problems);
    // Start in the plan's order: Dev, then the Host, then the coordinator.
    const order: ManagedService[] = ["dev", "host", "coordinator"];
    for (const service of order.filter((item) => everStopped.includes(item)))
      await ports.services.start(service).catch(() => undefined);
    throw error;
  }
  for (const part of replaced) await discardAside(part, restoreId, ports);
}

function describeStep(step: RestoreStep, parts: readonly StoredPart[]): string {
  const names = { coordinator: "the coordinator", host: "the Host daemon", dev: "Dev" };
  if (step.action === "stop") return `Stopping ${names[step.service]}`;
  if (step.action === "start") return `Starting ${names[step.service]}`;
  if (step.action === "restore") return `Restoring ${parts[step.index].part.source}`;
  return "Waiting for the coordinator";
}

/** Production Docker transfer for Dev's home. */
export const dockerSnapshotPorts: Omit<SnapshotPorts, "now"> = {
  async exportDocker(source, file) {
    const exclusions = SNAPSHOT_EXCLUDED_NAMES.flatMap((name) => [`--exclude=${name}`]);
    // Dev runs as root without CAP_DAC_OVERRIDE, so `docker exec` cannot read the Dev
    // user's private folders; a bind-mounted home is read through Dev's mounts instead.
    if (source.mounted)
      return pipeToFile(
        source.docker,
        await mountedHomeArgs(source, "export", ["--exclude=./.before-restore-*", ...exclusions]),
        file,
      );
    return pipeToFile(
      source.docker,
      ["exec", source.container, "tar", "-C", source.path, ...exclusions, "-cf", "-", "."],
      file,
    );
  },
  importDocker(source, file) {
    // `docker cp` from stdin overlays the archive; files created after the snapshot remain.
    return pipeFromFile(source.docker, ["cp", "-", `${source.container}:${source.path}`], file);
  },
};

// Runs as root in a one-shot container with Dev's mounts and Docker's default capabilities,
// so every file is readable and ownership is kept. The aside copy lives inside the mount,
// where a move is a rename.
const MOUNTED_HOME_SCRIPTS = {
  // The remaining arguments are tar options, such as exclusions. Dev keeps running, and
  // GNU tar exits 1 when a file changed while it was read; the archive is still whole.
  export: `set -eu
home="$1"; shift
status=0
tar -C "$home" "$@" -cf - . || status=$?
[ "$status" -eq 1 ] && exit 0
exit "$status"`,
  // Moves every entry aside one at a time, stopping at the first failure, and marks the
  // aside copy complete before unpacking. Without the mark nothing was unpacked yet.
  replace: `set -eu
home="$1"; aside="$home/.before-restore-$2"; complete="$aside.complete"
mkdir "$aside"
for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  [ "$entry" = "$aside" ] && continue
  mv "$entry" "$aside"/
done
touch "$complete"
tar -C "$home" --same-owner -xpf -`,
  // After a complete move the home holds only unpacked entries, which go; after a partial
  // one it still holds untouched originals, which stay. The aside entries then move back.
  revert: `set -eu
home="$1"; aside="$home/.before-restore-$2"; complete="$aside.complete"
[ -d "$aside" ] || exit 0
if [ -e "$complete" ]; then
  for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ "$entry" = "$aside" ] || [ "$entry" = "$complete" ] && continue
    rm -rf "$entry"
  done
fi
for entry in "$aside"/* "$aside"/.[!.]* "$aside"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  mv "$entry" "$home"/
done
rmdir "$aside"
rm -f "$complete"`,
  discard: `set -eu
rm -rf "$1/.before-restore-$2" "$1/.before-restore-$2.complete"`,
};

/** The script for `action`, for running in a shell; exported for tests. */
export function mountedHomeScript(action: keyof typeof MOUNTED_HOME_SCRIPTS): string {
  return MOUNTED_HOME_SCRIPTS[action];
}

async function mountedHomeArgs(
  source: DockerSource,
  action: keyof typeof MOUNTED_HOME_SCRIPTS,
  rest: string[],
): Promise<string[]> {
  // The image Dev's container was created from, present even while it is stopped.
  const image = await new Promise<string>((resolve, reject) => {
    const child = spawn(source.docker, ["inspect", "--format", "{{.Image}}", source.container], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const errors = collectStderr(child);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(exitError("docker inspect", code, errors()));
    });
  });
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--user",
    "0:0",
    "--volumes-from",
    source.container,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    MOUNTED_HOME_SCRIPTS[action],
    "restore",
    source.path,
    ...rest,
  ];
}

/** Keeps the end of a child's stderr for its error message. */
function collectStderr(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk) => (text = (text + chunk).slice(-2000)));
  return () => text.trim().split("\n").slice(-5).join("\n");
}

function exitError(command: string, code: number | null, stderr: string): Error {
  const name = path.basename(command);
  return new Error(`${name} exited with ${code}${stderr ? `: ${stderr}` : ""}`);
}

function runToEnd(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errors = collectStderr(child);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(exitError(command, code, errors()));
    });
  });
}

/** Production restore of a bind-mounted Dev home. */
export const mountedHomeRestore: MountedHomeRestore = {
  async replace(source, file, restoreId) {
    await pipeFromFile(source.docker, await mountedHomeArgs(source, "replace", [restoreId]), file);
  },
  async revert(source, restoreId) {
    await runToEnd(source.docker, await mountedHomeArgs(source, "revert", [restoreId]));
  },
  async discard(source, restoreId) {
    await runToEnd(source.docker, await mountedHomeArgs(source, "discard", [restoreId]));
  },
};

function pipeToFile(command: string, args: string[], file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(file, { mode: 0o600, flags: "wx" });
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const errors = collectStderr(child);
    child.stdout.pipe(output);
    child.on("error", reject);
    child.on("close", (code) => {
      output.close();
      if (code === 0) resolve();
      else reject(exitError(command, code, errors()));
    });
  });
}

function pipeFromFile(command: string, args: string[], file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    const errors = collectStderr(child);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(exitError(command, code, errors()));
    });
    createReadStream(file).on("error", reject).pipe(child.stdin);
  });
}
