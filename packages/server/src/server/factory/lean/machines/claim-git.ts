import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ClaimRefStore } from "./claims.js";

const execFileAsync = promisify(execFile);
const objectId = /^[a-f0-9]{40}$/;

function claimRef(issue: number): string {
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error("Invalid Factory issue number.");
  return `refs/vorteo/claims/${issue}`;
}

export interface GitClaimStoreOptions {
  /** Trusted daemon-owned repository with the project's GitHub origin. */
  cwd: string;
  /** Charge each Smart Git push attempt against the shared GitHub mutation budget. */
  chargeMutation(): Promise<void>;
}

export function createGitClaimStore(options: GitClaimStoreOptions): ClaimRefStore {
  async function run(args: string[], env = process.env): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  }

  async function remoteRevision(ref: string): Promise<string | null> {
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
      ...process.env,
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
      const ref = claimRef(issue);
      const revision = await remoteRevision(ref);
      if (!revision) return null;
      await run(["fetch", "--no-tags", "--no-write-fetch-head", "origin", revision]);
      const body = await run(["show", "-s", "--no-notes", "--format=%B", revision]);
      return { revision, body };
    },
    async compareAndSwap(issue, expected, body) {
      const ref = claimRef(issue);
      if (expected !== null && !objectId.test(expected)) {
        throw new Error("Invalid expected Factory claim revision.");
      }
      if (body === null && expected === null) {
        throw new Error("Deleting a Factory claim requires its expected revision.");
      }
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
