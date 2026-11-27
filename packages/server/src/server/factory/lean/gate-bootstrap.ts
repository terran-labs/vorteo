import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { FactoryGitHub } from "../project/claims.js";
import { createDockerGateBoundary, type GateExecutionBoundary } from "./gate-command-runner.js";
import type { PrimaryGateRuntimeOptions } from "./gate-runtime.js";
import { createGitReviewObjects } from "./review-evidence.js";

const exec = promisify(execFile);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const remoteRef = z.object({ ref: z.string(), object: z.object({ sha: oid }) });
const repoRef = z.object({ default_branch: z.string().min(1), full_name: z.string() });
const missing = z.object({ code: z.literal("ENOENT") });
const safeRepository = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;

type DockerSource = Omit<Parameters<typeof createDockerGateBoundary>[0], "machine">;
type GateOptions = Pick<PrimaryGateRuntimeOptions, "primary" | "execution">;
interface Ref {
  name: string;
  head: string;
}

export interface LeanGateBootstrapOptions {
  paseoHome: string;
  projectId: string;
  repository: string;
  primary: string;
  here: string;
  github: FactoryGitHub;
  holdsPrimary(): Promise<boolean>;
  /** Supplied only by the primary's trusted local deployment configuration. */
  docker?: DockerSource;
  /** A separately verified credential-free executor. Native daemon execution supplies no boundary. */
  hostBoundary?: GateExecutionBoundary;
  gitBinary?: string;
}

interface HeadTarget {
  issue: number;
  headSha: string;
  baseSha?: string;
}

export interface LeanEvidenceSource {
  repository: string;
  head: string;
  baseSha: string;
  gitDirectory: string;
}

/** Every path under the evidence root is privately created, with symlinks and shared write access refused. */
export async function evidenceDirectory(parent: string, ...components: string[]): Promise<string> {
  let current = await realpath(parent);
  for (const component of components) {
    if (!/^[\w.-]+$/u.test(component) || component === "." || component === "..") {
      throw new Error("Invalid Factory evidence directory.");
    }
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!z.object({ code: z.literal("EEXIST") }).safeParse(error).success) throw error;
    }
    const entry = await lstat(current);
    const uid = process.getuid?.();
    if (
      !entry.isDirectory() ||
      (entry.mode & 0o022) !== 0 ||
      (uid !== undefined && entry.uid !== uid)
    ) {
      throw new Error("Factory evidence storage must be owned by this daemon.");
    }
  }
  return current;
}

export function createEvidenceGit(binary = "/usr/bin/git") {
  if (!isAbsolute(binary)) throw new Error("Configure an absolute Git executable.");
  return async (cwd: string, args: readonly string[], limits: { maxBuffer?: number } = {}) => {
    const { stdout } = await exec(
      binary,
      [
        "--no-replace-objects",
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME,
          ...(process.env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } : {}),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          LC_ALL: "C",
        },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: limits.maxBuffer ?? 1024 * 1024,
      },
    );
    return stdout;
  };
}

export function createLeanGateBootstrap(options: LeanGateBootstrapOptions) {
  const { here, primary, repository, github } = options;
  if (!safeRepository.test(repository) || !isAbsolute(options.paseoHome)) {
    throw new Error("Factory needs a project repository and local state directory.");
  }
  const git = createEvidenceGit(options.gitBinary);
  const projectKey = createHash("sha256")
    .update(JSON.stringify([options.projectId, repository]))
    .digest("hex");
  const remote = `https://github.com/${repository}.git`;
  const holds = async () => here === primary && options.holdsPrimary();
  let tail = Promise.resolve();

  async function repositoryPool(): Promise<string> {
    const pool = await evidenceDirectory(
      options.paseoHome,
      "factory",
      "lean",
      "evidence",
      projectKey,
    );
    const repo = join(pool, "repository.git");
    try {
      const found = await lstat(repo);
      if (!found.isDirectory() || (found.mode & 0o077) !== 0)
        throw new Error("Invalid Factory evidence repository.");
    } catch (error) {
      if (!missing.safeParse(error).success) throw error;
      await evidenceDirectory(pool, "repository.git");
      await git(repo, ["init", "--bare", "--quiet", "--template="]);
    }
    if ((await git(repo, ["rev-parse", "--is-bare-repository"])).trim() !== "true") {
      throw new Error("Factory evidence must use its private bare repository.");
    }
    const locations = [join(repo, "config"), join(repo, "objects"), join(repo, "refs")];
    for (const file of locations) {
      if ((await lstat(file)).isSymbolicLink())
        throw new Error("Factory evidence has a redirected Git path.");
    }
    const entries = await git(repo, ["config", "--local", "--name-only", "--list"]);
    const safe = new Set([
      "core.repositoryformatversion",
      "core.filemode",
      "core.bare",
      "core.ignorecase",
      "core.precomposeunicode",
    ]);
    if (
      entries
        .trim()
        .split(/\r?\n/)
        .some((entry) => !safe.has(entry.toLowerCase()))
    ) {
      throw new Error("Factory evidence repository has unexpected Git configuration.");
    }
    try {
      await lstat(join(repo, "objects", "info", "alternates"));
      throw new Error("Factory evidence cannot read alternate object databases.");
    } catch (error) {
      if (!missing.safeParse(error).success) throw error;
    }
    return repo;
  }

  async function readRef(branch: string): Promise<Ref | null> {
    const name = `refs/heads/${branch}`;
    const path = branch.split("/").map(encodeURIComponent).join("/");
    const response = await github.rest("GET", `repos/${repository}/git/ref/heads/${path}`);
    if (response.status !== 200) return null;
    const parsed = remoteRef.safeParse(response.body);
    if (!parsed.success || parsed.data.ref !== name) return null;
    return { name, head: parsed.data.object.sha };
  }

  async function defaultRef(): Promise<Ref | null> {
    const response = await github.rest("GET", `repos/${repository}`);
    const info = repoRef.safeParse(response.body);
    if (
      response.status !== 200 ||
      !info.success ||
      info.data.full_name.toLowerCase() !== repository.toLowerCase()
    )
      return null;
    return readRef(info.data.default_branch);
  }

  async function pin(repo: string, ref: Ref): Promise<boolean> {
    const saved = `refs/factory/verified/${ref.head}`;
    const existing = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${saved}^{commit}`,
    ]).catch(() => "");
    if (existing.trim() === ref.head) return true;
    const incoming = `refs/factory/incoming/${randomUUID()}`;
    try {
      await git(repo, ["check-ref-format", ref.name]);
      await git(repo, [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-fetch-head",
        "--",
        remote,
        `${ref.name}:${incoming}`,
      ]);
      const actual = await git(repo, ["rev-parse", "--verify", `${incoming}^{commit}`]);
      if (actual.trim() !== ref.head) return false;
      await git(repo, ["update-ref", saved, ref.head]);
      return true;
    } finally {
      await git(repo, ["update-ref", "-d", incoming]);
    }
  }

  async function verifiedSource(target: HeadTarget): Promise<LeanEvidenceSource | null> {
    if (
      !Number.isSafeInteger(target.issue) ||
      target.issue < 1 ||
      !oid.safeParse(target.headSha).success ||
      !(await holds())
    )
      return null;
    const branch = `factory/issue-${target.issue}`;
    const [head, base] = await Promise.all([readRef(branch), defaultRef()]);
    if (
      !head ||
      !base ||
      head.head !== target.headSha ||
      (target.baseSha && base.head !== target.baseSha)
    )
      return null;
    const repo = await repositoryPool();
    if (!(await pin(repo, head)) || !(await pin(repo, base))) return null;
    const [afterHead, afterBase] = await Promise.all([readRef(branch), defaultRef()]);
    const unchanged =
      afterHead?.head === head.head &&
      afterBase?.head === base.head &&
      afterBase.name === base.name;
    if (!unchanged || !(await holds())) return null;
    return { repository, head: head.head, baseSha: base.head, gitDirectory: repo };
  }

  function sourceForHead(target: HeadTarget): Promise<LeanEvidenceSource | null> {
    const result = tail.then(() => verifiedSource(target)).catch(() => null);
    tail = result.then(() => undefined);
    return result;
  }

  const host = options.hostBoundary;
  const boundaries = {
    ...(options.docker
      ? { container: createDockerGateBoundary({ ...options.docker, machine: primary }) }
      : {}),
    ...(host?.machine === primary && host.where === "host" ? { host } : {}),
  };
  const primaryGates: GateOptions = { primary };
  if (here === primary && Object.keys(boundaries).length) {
    primaryGates.execution = {
      checkoutRoot: resolve(options.paseoHome, "factory", "lean", "gate-checkouts"),
      gitBinary: options.gitBinary,
      boundaries,
      async source(target) {
        if (target.repository !== repository || target.primary !== primary) return null;
        return sourceForHead({
          issue: target.issue,
          headSha: target.head,
          baseSha: target.configCommit,
        });
      },
    };
  }
  return {
    primaryGates,
    sourceForHead,
    async reviewObjects(target: Required<HeadTarget>) {
      const source = await sourceForHead(target);
      return source ? createGitReviewObjects(source.gitDirectory) : null;
    },
  };
}
