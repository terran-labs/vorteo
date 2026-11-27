import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import type { ClaimRefStore } from "./claims.js";

const execFileAsync = promisify(execFile);
const objectId = /^[a-f0-9]{40}$/;
const githubRemote = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/u;
const gitEnvironment = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

function issueRef(namespace: "claims" | "gate-batches", issue: number): string {
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error("Invalid Factory issue number.");
  return `refs/vorteo/${namespace}/${issue}`;
}

export interface GitClaimStoreOptions {
  /** Trusted daemon-owned repository with the project's GitHub origin. */
  cwd: string;
  repository: string;
  /** Explicit local fixture remote. Production transport allows HTTPS to GitHub only. */
  localRemote?: string;
  namespace?: "claims" | "gate-batches";
  /** Charge each Smart Git push attempt against the shared GitHub mutation budget. */
  chargeMutation(): Promise<void>;
}

export function createGitClaimStore(options: GitClaimStoreOptions): ClaimRefStore {
  const inherited = Object.fromEntries(gitEnvironment.map((name) => [name, process.env[name]]));
  const flags = [
    `--git-dir=${options.cwd}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.allow=never",
    "-c",
    options.localRemote ? "protocol.file.allow=always" : "protocol.https.allow=always",
    "-c",
    "http.followRedirects=false",
    "-c",
    "credential.helper=",
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
  ];
  async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    const { stdout } = await execFileAsync("git", [...flags, ...args], {
      cwd: options.cwd,
      env: {
        ...inherited,
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  }

  async function assertCanonicalOrigin(): Promise<void> {
    const [configured, fetch, push] = await Promise.all([
      run(["config", "--local", "--get-all", "remote.origin.url"]),
      run(["remote", "get-url", "--all", "origin"]),
      run(["remote", "get-url", "--push", "--all", "origin"]),
    ]);
    const expected = options.localRemote ?? `https://github.com/${options.repository}.git`;
    const valid = options.localRemote ? isAbsolute(expected) : githubRemote.test(expected);
    if (!valid || configured !== expected || fetch !== expected || push !== expected) {
      throw new Error("Factory refs require matching canonical fetch and push URLs.");
    }
  }

  async function remoteRevision(ref: string): Promise<string | null> {
    await assertCanonicalOrigin();
    let entry: string;
    try {
      entry = await run(["ls-remote", "--exit-code", "--refs", "origin", ref]);
    } catch (error) {
      if ((error as { code?: unknown }).code === 2) return null;
      throw error;
    }
    const [revision, name] = entry.split("\t");
    if (!revision || !objectId.test(revision) || name !== ref) {
      throw new Error("Git returned an unexpected Factory claim ref.");
    }
    return revision;
  }

  async function writeObject(body: string): Promise<string> {
    const tree = await run(["hash-object", "-w", "-t", "tree", "/dev/null"]);
    // The ref is public. Keep commit identity and time independent of local configuration.
    return run(["-c", "commit.gpgSign=false", "commit-tree", tree, "-m", body], {
      GIT_AUTHOR_NAME: "Factory",
      GIT_AUTHOR_EMAIL: "factory@invalid.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Factory",
      GIT_COMMITTER_EMAIL: "factory@invalid.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
  }

  return {
    async read(issue) {
      const ref = issueRef(options.namespace ?? "claims", issue);
      const revision = await remoteRevision(ref);
      if (!revision) return null;
      await run(["fetch", "--no-tags", "--no-write-fetch-head", "origin", revision]);
      const body = await run(["show", "-s", "--no-notes", "--format=%B", revision]);
      return { revision, body };
    },
    async compareAndSwap(issue, expected, body) {
      const ref = issueRef(options.namespace ?? "claims", issue);
      if (expected !== null && !objectId.test(expected)) {
        throw new Error("Invalid expected Factory claim revision.");
      }
      if (body === null && expected === null) {
        throw new Error("Deleting a Factory claim requires its expected revision.");
      }
      await assertCanonicalOrigin();
      const next = body === null ? null : await writeObject(body);
      await options.chargeMutation();
      try {
        await run([
          "-c",
          "push.followTags=false",
          "push",
          "--porcelain",
          `--force-with-lease=${ref}:${expected ?? ""}`,
          "origin",
          `${next ?? ""}:${ref}`,
        ]);
        return true;
      } catch (error) {
        // A lost response may follow an accepted push. Distinguish it from a competing update.
        const observed = await remoteRevision(ref);
        if (observed === next) return true;
        if (observed !== expected) return false;
        throw error;
      }
    },
  };
}
