import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  validGateCommand,
  validGateTarget,
  type GateCommandExecution,
  type GateTarget,
  type IssueGateCommand,
} from "./gate-receipts.js";

const exec = promisify(execFile);
const probeTimeout = 30_000;
const maxOutputBytes = 4 * 1024 * 1024;

interface VerifiedGateSource {
  repository: string;
  head: string;
  /** Daemon-verified local object database. A Builder checkout is not a trusted source. */
  gitDirectory: string;
}

interface GateCommandRequest {
  cwd: string;
  argv: readonly string[];
  authorizeLaunch: () => Promise<boolean>;
}

export interface GateExecutionBoundary {
  machine: string;
  where: IssueGateCommand["where"];
  /** Daemon-owned adapter. Run only inside a credential-free isolation boundary and
   * call authorizeLaunch immediately before starting the configured command. */
  run(input: GateCommandRequest): Promise<{ exitCode: number; stdout: string } | null>;
}

interface GateCommandRunnerOptions {
  primary: string;
  checkoutRoot: string;
  source(target: GateTarget): Promise<VerifiedGateSource | null>;
  boundaries: Partial<Record<IssueGateCommand["where"], GateExecutionBoundary>>;
  gitBinary?: string;
  now?: () => Date;
}

async function privateCheckout(
  gitBinary: string,
  root: string,
  source: VerifiedGateSource,
): Promise<{ cwd: string; tree: string; verify(): Promise<boolean> }> {
  const cwd = join(root, "checkout");
  const home = join(root, "home");
  const empty = join(root, "empty");
  await Promise.all([cwd, home, empty].map((directory) => mkdir(directory, { mode: 0o700 })));
  const gitDirectory = await realpath(source.gitDirectory);
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  async function git(...args: string[]): Promise<string> {
    const result = await exec(
      gitBinary,
      ["--no-replace-objects", "-c", `core.hooksPath=${empty}`, "-C", cwd, ...args],
      { env, timeout: probeTimeout, maxBuffer: maxOutputBytes },
    );
    return result.stdout.trim();
  }

  const format = source.head.length === 40 ? "sha1" : "sha256";
  await git("init", "--quiet", `--object-format=${format}`, `--template=${empty}`);
  await git(
    "-c",
    "protocol.file.allow=always",
    "-c",
    "fetch.fsckObjects=true",
    "fetch",
    "--quiet",
    "--depth=1",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    gitDirectory,
    source.head,
  );
  await git("checkout", "--quiet", "--detach", source.head);
  const tree = await git("rev-parse", "--verify", "HEAD^{tree}");
  async function verify(): Promise<boolean> {
    const [head, ref, status] = await Promise.all([
      git("rev-parse", "--verify", "HEAD^{commit}"),
      git("rev-parse", "--abbrev-ref", "HEAD"),
      git("status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
    ]);
    return head === source.head && ref === "HEAD" && status === "";
  }
  if (!/^[a-f0-9]+$/u.test(tree) || tree.length !== source.head.length || !(await verify())) {
    throw new Error("Factory could not verify the detached gate checkout.");
  }
  return { cwd, tree, verify };
}

async function createScratch(root: string): Promise<string> {
  await mkdir(root, { mode: 0o700, recursive: true });
  const path = await realpath(root);
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))
  ) {
    throw new Error("Factory gate storage must be a private daemon directory.");
  }
  return mkdtemp(join(path, "gate-"));
}

/** Materialize a fresh exact-head checkout with no inherited credentials or remote. */
export function createGateCommandRunner(options: GateCommandRunnerOptions) {
  const { primary, checkoutRoot } = options;
  const gitBinary = options.gitBinary ?? "/usr/bin/git";
  const now = options.now ?? (() => new Date());
  if (!isAbsolute(checkoutRoot) || !isAbsolute(gitBinary)) {
    throw new Error("Factory gate checkout and executable paths must be absolute.");
  }

  return async function execute(
    target: GateTarget,
    command: IssueGateCommand,
    authorizeLaunch: () => Promise<boolean>,
  ): Promise<GateCommandExecution | null> {
    if (!validGateTarget(target) || !validGateCommand(command) || target.primary !== primary)
      return null;
    const boundary = options.boundaries[command.where];
    if (!boundary || boundary.machine !== primary || boundary.where !== command.where) return null;
    let scratch: string | undefined;
    try {
      const source = await options.source(target);
      if (
        !source ||
        source.head !== target.head ||
        source.repository !== target.repository ||
        !isAbsolute(source.gitDirectory)
      )
        return null;
      scratch = await createScratch(checkoutRoot);
      const checkout = await privateCheckout(gitBinary, scratch, source);
      let startedAt: string | null = null;
      const result = await boundary.run({
        cwd: checkout.cwd,
        argv: [...command.argv],
        async authorizeLaunch() {
          if (!(await authorizeLaunch()) || !(await checkout.verify())) return false;
          startedAt = now().toISOString();
          return true;
        },
      });
      if (!result || startedAt === null) return null;
      return {
        head: target.head,
        machine: primary,
        where: command.where,
        tree: checkout.tree,
        exitCode: result.exitCode,
        outputMatched:
          command.requiredOutput === undefined ||
          result.stdout.split(/\r?\n/u).includes(command.requiredOutput),
        startedAt,
        finishedAt: now().toISOString(),
      };
    } catch {
      // Child errors contain command output and inherited tool diagnostics. Keep them private.
      return null;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  };
}

interface DockerGateBoundaryOptions {
  machine: string;
  /** Trusted Docker engine local to this primary. Never forwarded to a guest. */
  socket: string;
  /** A verified, already available Dev image ID. Tags and pull-on-demand are not accepted. */
  image: string;
  dockerBinary: string;
  /** A non-root UID/GID that can write the disposable checkout. */
  uid: number;
  gid: number;
  timeoutMs?: number;
}

interface DockerState {
  Status?: string;
  ExitCode?: number;
  Error?: string;
  OOMKilled?: boolean;
  StartedAt?: string;
}

/** The supported disposable container boundary. It never runs in the installed Dev container. */
export function createDockerGateBoundary(
  options: DockerGateBoundaryOptions,
): GateExecutionBoundary {
  const { machine, socket, image, dockerBinary, uid, gid } = options;
  const timeout = options.timeoutMs ?? 10 * 60_000;
  if (
    !isAbsolute(socket) ||
    !isAbsolute(dockerBinary) ||
    !/^sha256:[a-f0-9]{64}$/u.test(image) ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0
  ) {
    throw new Error("Factory needs a verified local Dev image and a non-root Docker executor.");
  }

  async function docker(args: string[], timeoutMs = probeTimeout): Promise<string> {
    const { stdout } = await exec(dockerBinary, ["--host", `unix://${socket}`, ...args], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
    });
    return stdout;
  }

  async function attachedOutput(name: string): Promise<string | null> {
    try {
      return await docker(["start", "--attach", name], timeout);
    } catch (error) {
      const failed = error as {
        code?: unknown;
        stdout?: unknown;
        signal?: unknown;
        killed?: unknown;
      };
      if (
        typeof failed.code !== "number" ||
        typeof failed.stdout !== "string" ||
        failed.signal ||
        failed.killed
      )
        return null;
      return failed.stdout;
    }
  }

  return {
    machine,
    where: "container",
    async run({ cwd, argv, authorizeLaunch }) {
      if (cwd !== resolve(cwd) || /[,\r\n]/u.test(cwd) || argv.length === 0) return null;
      const name = `vorteo-factory-gate-${randomUUID()}`;
      try {
        await docker([
          "create",
          "--name",
          name,
          "--pull=never",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "256",
          "--no-healthcheck",
          "--user",
          `${uid}:${gid}`,
          "--workdir",
          "/checkout",
          "--mount",
          `type=bind,source=${cwd},target=/checkout`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,mode=1777",
          "--entrypoint",
          "/usr/bin/env",
          image,
          "-i",
          "HOME=/tmp",
          "TMPDIR=/tmp",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "LANG=C",
          ...argv,
        ]);
        if (!(await authorizeLaunch())) return null;
        const stdout = await attachedOutput(name);
        if (stdout === null) return null;
        const state = JSON.parse(
          await docker(["inspect", "--type", "container", "--format", "{{json .State}}", name]),
        ) as DockerState;
        if (
          state.Status !== "exited" ||
          state.OOMKilled !== false ||
          state.Error !== "" ||
          typeof state.ExitCode !== "number" ||
          !Number.isFinite(Date.parse(state.StartedAt ?? ""))
        )
          return null;
        return { exitCode: state.ExitCode, stdout };
      } catch {
        return null;
      } finally {
        await docker(["rm", "--force", "--volumes", name]).catch(() => undefined);
      }
    },
  };
}
