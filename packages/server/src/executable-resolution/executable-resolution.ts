import { getProviderProbeCwd } from "../utils/provider-probe-cwd.js";
import { constants, existsSync } from "node:fs";
import { access, lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, normalize, resolve } from "node:path";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { execCommand } from "../utils/spawn.js";
import which from "which";
import { windowsExecutableResolution } from "./windows.js";

const PROBE_TIMEOUT_MS = 2000;
const MAX_SYMLINK_DEPTH = 40;

/** Common per-user and package-manager bin folders searched on POSIX when a daemon PATH omits them. */
const POSIX_FALLBACK_BIN_DIRS = [
  { homeRelative: ".local/bin" },
  { homeRelative: "bin" },
  { homeRelative: ".cargo/bin" },
  { absolute: "/opt/homebrew/bin" },
  { absolute: "/usr/local/bin" },
] as const;

function resolveAbsoluteHome(env?: ProcessEnvRecord): string | null {
  for (const candidate of [env?.HOME?.trim(), process.env.HOME?.trim(), homedir()]) {
    if (candidate && isAbsolute(candidate)) return candidate;
  }
  return null;
}

function isTrustedPosixOwner(info: { uid: number }): boolean {
  const uid = process.getuid?.();
  return uid === undefined || info.uid === uid || info.uid === 0;
}

function isStrictlyNonGroupOrWorldWritable(info: { uid: number; mode: number }): boolean {
  return (info.mode & 0o022) === 0 && isTrustedPosixOwner(info);
}

function isTrustedAncestorDir(info: { uid: number; mode: number }): boolean {
  if (!isTrustedPosixOwner(info)) return false;
  // Sticky root-owned directories (such as /tmp or /private/tmp) prevent non-owners from
  // renaming or replacing entries owned by another user.
  if (info.uid === 0 && (info.mode & 0o1000) !== 0) return true;
  return (info.mode & 0o022) === 0;
}

function isTrustedFinalEntry(
  info: { uid: number; mode: number; isDirectory(): boolean; isFile(): boolean },
  expect: "dir" | "file",
): boolean {
  const matchesKind = expect === "dir" ? info.isDirectory() : info.isFile();
  return matchesKind && isStrictlyNonGroupOrWorldWritable(info);
}

/**
 * Walks every ancestor directory and symlink hop from `/` to `targetPath` so no group-writable,
 * world-writable, or non-owner/non-root component can shadow a fallback CLI binary.
 */
async function resolveTrustedPosixPath(
  targetPath: string,
  expect: "dir" | "file",
  depth = 0,
): Promise<string | null> {
  if (depth > MAX_SYMLINK_DEPTH || !isAbsolute(targetPath)) return null;
  try {
    const rootInfo = await lstat("/");
    if (!rootInfo.isDirectory() || !isTrustedAncestorDir(rootInfo)) return null;

    const segments = normalize(targetPath).split("/").filter(Boolean);
    if (segments.length === 0) return null;

    let current = "/";
    for (let index = 0; index < segments.length; index += 1) {
      const next = join(current, segments[index]!);
      const info = await lstat(next);
      if (!isTrustedPosixOwner(info)) return null;

      if (info.isSymbolicLink()) {
        const linkTarget = await readlink(next);
        const resolvedLink = isAbsolute(linkTarget) ? linkTarget : resolve(current, linkTarget);
        const remaining = segments.slice(index + 1);
        const nextPath = remaining.length > 0 ? join(resolvedLink, ...remaining) : resolvedLink;
        return resolveTrustedPosixPath(nextPath, expect, depth + 1);
      }

      const isFinal = index === segments.length - 1;
      const trusted = isFinal
        ? isTrustedFinalEntry(info, expect)
        : info.isDirectory() && isTrustedAncestorDir(info);
      if (!trusted) return null;

      current = next;
    }
    return current;
  } catch {
    return null;
  }
}

async function isTrustedFallbackDir(dir: string): Promise<boolean> {
  return (await resolveTrustedPosixPath(dir, "dir")) !== null;
}

async function isTrustedExecutableFile(filePath: string): Promise<boolean> {
  const resolved = await resolveTrustedPosixPath(filePath, "file");
  if (!resolved) return false;
  try {
    await access(resolved, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function fallbackExecutableDirs(env?: ProcessEnvRecord): string[] {
  if (process.platform === "win32") return [];
  const home = resolveAbsoluteHome(env);
  const pathEntries = new Set(
    (env?.PATH ?? process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const dirs: string[] = [];
  for (const entry of POSIX_FALLBACK_BIN_DIRS) {
    let dir = "";
    if ("homeRelative" in entry) {
      if (home) dir = join(home, entry.homeRelative);
    } else {
      dir = entry.absolute;
    }
    if (dir && !pathEntries.has(dir) && !dirs.includes(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

export function describeExecutableSearch(
  command: string,
  options?: { env?: ProcessEnvRecord; providerId?: string; includeFallbackDirs?: boolean },
): string {
  const configHint = options?.providerId
    ? ` Set agents.providers.${options.providerId}.command in config.json to point Vorteo at the binary.`
    : "";
  if (hasPathSeparator(command.trim())) {
    return `Could not find executable "${command}".${configHint}`;
  }
  const pathValue = options?.env?.PATH ?? process.env.PATH ?? "";
  const searched = [
    ...pathValue
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
    ...(options?.includeFallbackDirs === false ? [] : fallbackExecutableDirs(options?.env)),
  ];
  const unique = Array.from(new Set(searched));
  const where = unique.length > 0 ? unique.join(", ") : "empty PATH";
  return `Could not find "${command}" (searched: ${where}).${configHint}`;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string, env?: ProcessEnvRecord): Promise<string[]> {
  if (process.platform !== "win32" && existsSync("/usr/bin/which")) {
    return enumerateCandidatesViaSystemWhich(name, env);
  }
  return enumerateCandidatesViaLibrary(name, env);
}

async function enumerateCandidatesViaSystemWhich(
  name: string,
  env?: ProcessEnvRecord,
): Promise<string[]> {
  try {
    const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
      baseEnv: env,
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch (error) {
    // which exits 1 for a missing command. A failed lookup is not evidence of absence.
    if (error instanceof Error && "code" in error && error.code === 1) return [];
    throw error;
  }
}

async function enumerateCandidatesViaLibrary(
  name: string,
  env?: ProcessEnvRecord,
): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await which(name, { all: true, path: env?.PATH, pathExt: env?.PATHEXT });
  } catch (error) {
    // `which` throws ENOENT when the command is absent from PATH.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

export async function probeExecutable(
  executablePath: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const { probeTimeoutMs: timeoutMs = PROBE_TIMEOUT_MS, env } =
    typeof options === "number" ? { probeTimeoutMs: options } : options;
  try {
    await execCommand(executablePath, ["--version"], {
      cwd: await getProviderProbeCwd(),
      baseEnv: env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (error) {
    return classifyProbeError(error);
  }
}

function classifyProbeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  if (err.killed) {
    return true;
  }
  if (typeof err.code === "number") {
    return true;
  }
  if (
    err.code === "ENOENT" ||
    err.code === "EACCES" ||
    err.code === "ENOEXEC" ||
    err.code === "UNKNOWN"
  ) {
    return false;
  }
  return false;
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (process.platform === "win32") {
    return windowsExecutableResolution.exists(executablePath, { exists });
  }
  return exists(executablePath) ? executablePath : null;
}

// PATH lookup that never runs the candidate, unlike findExecutable which probes
// each one with `--version`. A terminal spawn path cannot afford that probe: it
// would execute the profile command once before the terminal even opens.
// `path` overrides the PATH to search, so a caller can resolve against the
// environment its child process will actually get rather than the daemon's own.
export async function findExecutableWithoutProbing(
  name: string,
  options: { path?: string; cwd: string },
): Promise<string | null> {
  if (!name) {
    return null;
  }
  const path =
    options.path === undefined
      ? undefined
      : options.path
          .split(delimiter)
          .map((entry) => resolve(options.cwd, entry))
          .join(delimiter);
  const candidates = await enumerateCandidatesViaLibrary(name, { PATH: path });
  return candidates[0] ?? null;
}

export interface ExecutableResolutionOptions {
  probeTimeoutMs?: number;
  env?: ProcessEnvRecord;
  includeFallbackDirs?: boolean;
}

export async function findExecutable(
  name: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const {
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    env,
    includeFallbackDirs = true,
  } = typeof options === "number" ? { probeTimeoutMs: options } : options;
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return null;
  }

  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: (command) => enumerateCandidates(command, env),
      probeExecutable: (command, timeout) =>
        probeExecutable(command, { probeTimeoutMs: timeout, env }),
      exists: existsSync,
      probeTimeoutMs,
    });
  }

  if (hasPathSeparator(trimmed)) {
    const candidate = resolve(trimmed);
    return (await probeExecutable(candidate, { probeTimeoutMs, env })) ? trimmed : null;
  }

  const pathCandidates = await enumerateCandidates(trimmed, env);
  for (const candidate of pathCandidates) {
    if (await probeExecutable(candidate, { probeTimeoutMs, env })) {
      return candidate;
    }
  }
  if (!includeFallbackDirs) {
    return null;
  }
  const seen = new Set(pathCandidates);
  for (const dir of fallbackExecutableDirs(env)) {
    if (!(await isTrustedFallbackDir(dir))) continue;
    const candidate = join(dir, trimmed);
    if (!seen.has(candidate) && (await isTrustedExecutableFile(candidate))) {
      seen.add(candidate);
      if (await probeExecutable(candidate, { probeTimeoutMs, env })) {
        return candidate;
      }
    }
  }
  return null;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
