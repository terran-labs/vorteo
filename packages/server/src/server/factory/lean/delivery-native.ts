import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { PushPayload } from "../../push/index.js";
import type { ProjectRegistry } from "../../workspace-registry.js";
import { ProjectFactoryStateStore, projectFactoryStatePath } from "../project/state.js";
import { createLeanDeliveryHostGate } from "./delivery-host-gate.js";
import { createDeliveryBranchEvidence, type DeliveryRuntimeProvider } from "./delivery-runtime.js";
import {
  createDeliveryCheckout,
  createHostStepAdapter,
  createOutputFiles,
  createProcessSpawner,
  createVerifiedCheckout,
  type GitRunner,
} from "./delivery/adapters.js";
import type { CheckPort } from "./delivery/executor.js";
import { evidenceDirectory } from "./gate-bootstrap.js";
import type { CleanRebaseProof, ReviewGitObjects } from "./review-evidence.js";

type Project = Parameters<DeliveryRuntimeProvider>[0];
const repositoryName = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/iu;
const component = z.string().regex(/^[a-z\d][a-z\d_.-]{0,79}$/iu);
const checkoutConfig = z.object({
  name: component,
  links: z
    .array(z.object({ name: z.literal("Syn3h-stable"), target: z.string() }))
    .max(1)
    .default([]),
});
const repositoryInfo = z.object({ full_name: z.string(), default_branch: z.string().min(1) });
const user = z.object({
  login: z.string().regex(/^[a-z\d-]+$/iu),
  id: z.number().int().positive(),
});
const sha = z.string().regex(/^[a-f\d]{40}$/u);
const missing = z.object({ code: z.literal("ENOENT") });
const exec = promisify(execFile);
const checkRuns = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(
    z.object({
      name: z.string(),
      head_sha: sha,
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});

export interface NativeDeliveryOptions {
  paseoHome: string;
  projects: Pick<ProjectRegistry, "get">;
  /** Verified native installation authority, checked again at the execution edge. */
  isManagedHost(): Promise<boolean>;
  canRun(): boolean;
  notifyOwner(payload: PushPayload): Promise<void>;
  unavailable(projectId: string, reason: string): void;
}

function exactChecks({ github, repository }: Project): CheckPort {
  return {
    async result(commit, name) {
      const query = new URLSearchParams({ check_name: name, filter: "latest", per_page: "100" });
      const response = await github.rest(
        "GET",
        `repos/${repository}/commits/${sha.parse(commit)}/check-runs?${query}`,
      );
      const data = checkRuns.safeParse(response.body);
      if (response.status !== 200 || !data.success) return "pending";
      const { total_count: count, check_runs: runs } = data.data;
      if (
        count !== runs.length ||
        runs.some((run) => run.head_sha !== commit || run.name !== name)
      ) {
        return "pending";
      }
      if (runs.length !== 1 || runs[0]?.status !== "completed") return "pending";
      return runs[0].conclusion === "success" ? "pass" : "fail";
    },
  };
}

async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing.safeParse(error).success) return null;
    throw error;
  }
}

async function owned(path: string, kind: "file" | "directory", privateMode = false) {
  const info = await entry(path);
  if (!info) return false;
  if (
    info.uid !== process.getuid?.() ||
    (info.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    !(kind === "file" ? info.isFile() : info.isDirectory())
  ) {
    throw new Error("Factory delivery found a redirected or shared path.");
  }
  return true;
}

/** Processes only run reviewed recipe commands in a private checkout. Git uses a separate env. */
function commandEnvironment() {
  return {
    HOME: homedir(),
    PATH: [
      dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: devNull,
    GIT_CONFIG_KEY_1: "protocol.file.allow",
    GIT_CONFIG_VALUE_1: "never",
  };
}

function privateGit(home: string, baseEnv: Record<string, string>) {
  const isolatedEnv = {
    ...baseEnv,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_LAZY_FETCH: "1",
    GIT_GRAFT_FILE: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  async function raw(cwd: string, args: string[], env: Record<string, string> = {}) {
    if (
      (cwd !== home && !cwd.startsWith(home + sep)) ||
      (await realpath(cwd)) !== cwd ||
      !(await owned(cwd, "directory"))
    ) {
      throw new Error("Factory delivery Git requires protected native storage.");
    }
    const { stdout } = await exec(
      "/usr/bin/git",
      [
        "--no-replace-objects",
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "http.followRedirects=false",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "push.recurseSubmodules=no",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        ...args,
      ],
      {
        cwd,
        env: { ...isolatedEnv, ...env },
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return stdout;
  }
  return {
    raw,
    async run(cwd: string, args: string[], env?: Record<string, string>) {
      return (await raw(cwd, args, env)).toString("utf8").trim();
    },
  };
}

const poolKeys = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.logallrefupdates",
  "remote.origin.url",
  "remote.origin.fetch",
]);

async function verifyPool(git: GitRunner, parent: string, pool: string, remoteUrl?: string) {
  const config = join(pool, "config");
  if (
    !(await owned(config, "file")) ||
    !(await owned(join(pool, "objects"), "directory")) ||
    !(await owned(join(pool, "refs"), "directory")) ||
    !(await owned(join(pool, "objects", "info"), "directory")) ||
    (await entry(join(pool, "objects", "info", "alternates"))) ||
    (await entry(join(pool, "objects", "info", "http-alternates")))
  ) {
    return false;
  }
  // Inspect with includes disabled before letting Git use the pool as a repository.
  const readConfig = (args: string[]) =>
    git.run(parent, ["config", "--file", config, "--no-includes", ...args]);
  const keys = await readConfig(["--name-only", "--list"]);
  const names = keys.split("\n");
  if (names.some((key) => !poolKeys.has(key))) return false;
  if (remoteUrl === undefined && names.some((key) => key.startsWith("remote."))) return false;
  if (
    remoteUrl !== undefined &&
    (await readConfig(["--get-all", "remote.origin.url"])) !== remoteUrl
  )
    return false;
  return (await readConfig(["--get-all", "core.bare"])) === "true";
}

async function verifyGitCustody(
  git: GitRunner,
  parent: string,
  pool: string,
  checkout: string,
  remoteUrl: string,
) {
  const hasPool = await owned(pool, "directory");
  const hasCheckout = await owned(checkout, "directory");
  if (!hasPool) return !hasCheckout;
  if (!(await verifyPool(git, parent, pool, remoteUrl))) return false;
  if (!hasCheckout) return true;
  const pointer = join(checkout, ".git");
  if (!(await owned(pointer, "file"))) return false;
  const gitdir = /^gitdir: (\/[^\r\n]+)\r?\n?$/u.exec(await readFile(pointer, "utf8"))?.[1];
  const worktrees = join(pool, "worktrees");
  if (!gitdir || resolve(gitdir) !== gitdir || dirname(gitdir) !== worktrees) return false;
  if (!(await owned(worktrees, "directory")) || !(await owned(gitdir, "directory"))) return false;
  const common = join(gitdir, "commondir");
  const backlink = join(gitdir, "gitdir");
  return (
    (await owned(common, "file")) &&
    (await readFile(common, "utf8")).trim() === "../.." &&
    (await owned(backlink, "file")) &&
    (await readFile(backlink, "utf8")).trimEnd() === pointer &&
    !(await entry(join(gitdir, "config.worktree")))
  );
}

async function trackedLinksStayPrivate(git: GitRunner, checkout: string) {
  const indexed = await git.run(checkout, ["ls-files", "--format=%(objectmode) %(path)", "-z"]);
  for (const item of indexed.split("\0")) {
    if (!item.startsWith("120000 ")) continue;
    const target = await realpath(join(checkout, item.slice("120000 ".length)));
    if (!target.startsWith(checkout + sep)) return false;
  }
  return true;
}

async function canonicalPrivate(path: string) {
  return (await realpath(path)) === path && (await owned(path, "directory", true));
}

async function validArtifactTarget(path: string) {
  return isAbsolute(path) && (await realpath(path)) === path && (await lstat(path)).isDirectory();
}

async function approvedArtifactLink(parent: string, target?: string) {
  const link = join(parent, "Syn3h-stable");
  const found = await entry(link);
  if (!target) return found === null;
  return (
    (await validArtifactTarget(target)) &&
    (found === null || (found.isSymbolicLink() && (await readlink(link)) === target))
  );
}

async function privateLocations(home: string, projectId: string, repository: string) {
  if (!(await canonicalPrivate(home)))
    throw new Error("Factory delivery requires a private native daemon home.");
  const key = createHash("sha256")
    .update(JSON.stringify([projectId, repository.toLowerCase()]))
    .digest("hex");
  const parent = await evidenceDirectory(home, "factory", "lean", "delivery-checkouts", key);
  const logDir = await evidenceDirectory(parent, "logs");
  if (!(await canonicalPrivate(parent)) || !(await canonicalPrivate(logDir)))
    throw new Error("Factory delivery requires private storage.");
  return { parent, logDir };
}

function historicalReviewObjects(
  git: ReturnType<typeof privateGit>,
  home: string,
  projectId: string,
  repository: string,
) {
  // This is the existing issue gate's authenticated, private evidence pool. Never fetch here.
  const key = createHash("sha256")
    .update(JSON.stringify([projectId, repository]))
    .digest("hex");
  const parent = join(home, "factory", "lean", "evidence", key);
  const pool = join(parent, "repository.git");
  return async (proof: CleanRebaseProof): Promise<ReviewGitObjects | null> => {
    try {
      if (
        !(await canonicalPrivate(parent)) ||
        !(await canonicalPrivate(pool)) ||
        !(await verifyPool(git, parent, pool))
      )
        return null;
      for (const commit of new Set([
        proof.prior.headSha,
        proof.prior.baseSha,
        proof.current.headSha,
        proof.current.baseSha,
      ])) {
        const id = sha.parse(commit);
        const pinned = await git.run(pool, [
          "rev-parse",
          "--verify",
          `refs/factory/verified/${id}^{commit}`,
        ]);
        if (pinned !== id) return null;
      }
      return {
        async read(type, oid) {
          return git.raw(pool, ["cat-file", type, sha.parse(oid)]);
        },
        async mergeBases(a, b) {
          const bases = await git.run(pool, ["merge-base", "--all", sha.parse(a), sha.parse(b)]);
          return bases.split(/\s+/u);
        },
        async isLinearDescendant(base, head) {
          if (base === head) return false;
          await git.run(pool, ["merge-base", "--is-ancestor", sha.parse(base), sha.parse(head)]);
          return !(await git.run(pool, [
            "rev-list",
            "--max-count=1",
            "--merges",
            `${base}..${head}`,
          ]));
        },
      };
    } catch {
      return null;
    }
  };
}

export function createNativeDeliveryProvider(
  options: NativeDeliveryOptions,
): DeliveryRuntimeProvider {
  const bindingPath = projectFactoryStatePath(options.paseoHome);
  const projects = new ProjectFactoryStateStore(bindingPath);
  async function hasRepositoryBinding(projectId: string, repository: string) {
    if (
      !(await canonicalPrivate(options.paseoHome)) ||
      !(await owned(dirname(bindingPath), "directory")) ||
      !(await owned(bindingPath, "file"))
    )
      return false;
    const binding = (await projects.read()).projects[projectId];
    return (
      binding?.mode === "lean" &&
      binding.enabled &&
      !binding.paused &&
      !binding.drain &&
      binding.home?.environment === "host" &&
      (binding.home.projectId === null || binding.home.projectId === projectId) &&
      binding.repository.toLowerCase() === repository.toLowerCase()
    );
  }
  return async (project) => {
    const { projectId, repository, github, readOwnerDelivery } = project;
    if (!(await options.isManagedHost().catch(() => false))) return null;
    try {
      const configured = await readOwnerDelivery();
      if (!configured) return null;
      const config = checkoutConfig.safeParse(configured.checkout);
      if (!config.success || !repositoryName.test(repository)) {
        options.unavailable(projectId, "Set a named private release checkout in Factory settings.");
        return null;
      }
      const { name, links } = config.data;
      if (["repo.git", "logs", "syn3h-stable"].includes(name.toLowerCase())) {
        throw new Error("The delivery checkout name is reserved.");
      }
      for (const { target } of links) {
        if (!(await validArtifactTarget(target))) {
          throw new Error("The release artifact directory needs a real absolute path.");
        }
      }
      const projectRecord = await options.projects.get(projectId);
      if (!projectRecord || projectRecord.kind !== "git" || projectRecord.archivedAt)
        throw new Error("Delivery requires an active registered Git project.");
      const projectRoot = projectRecord.rootPath;
      const baseEnv = commandEnvironment();
      const git = privateGit(options.paseoHome, baseEnv);
      if (!(await hasRepositoryBinding(projectId, repository)))
        throw new Error(
          "The verified native Factory project binding does not match the repository.",
        );
      const metadata = async () => {
        const response = await github.rest("GET", `repos/${repository}`);
        const info = repositoryInfo.safeParse(response.body);
        return response.status === 200 &&
          info.success &&
          info.data.full_name.toLowerCase() === repository.toLowerCase()
          ? info.data
          : null;
      };
      const [repo, actor] = await Promise.all([metadata(), github.rest("GET", "user")]);
      const verifiedActor = user.safeParse(actor.body);
      if (!repo || actor.status !== 200 || !verifiedActor.success) {
        throw new Error("The Host needs verified GitHub access to record releases.");
      }
      const { default_branch: defaultBranch } = repo;
      await git.run(options.paseoHome, ["check-ref-format", `refs/heads/${defaultBranch}`]);
      const { parent, logDir } = await privateLocations(options.paseoHome, projectId, repository);
      const pool = join(parent, "repo.git");
      const checkout = join(parent, name);
      const remoteUrl = `https://github.com/${repository}.git`;
      const branch = createDeliveryBranchEvidence(github, repository);
      const { login, id } = verifiedActor.data;
      const deliveryCheckout = createDeliveryCheckout({
        pool,
        path: checkout,
        links,
        remoteUrl,
        defaultBranch,
        git,
        identity: { name: "Vorteo Factory", email: `${id}+${login}@users.noreply.github.com` },
      });
      const host = createHostStepAdapter({
        spawner: createProcessSpawner(),
        files: createOutputFiles(),
        checkout: createVerifiedCheckout({ gitPath: checkout, cwd: checkout, git }),
        baseEnv: {
          ...baseEnv,
          GIT_COMMITTER_NAME: "Vorteo Factory",
          GIT_COMMITTER_EMAIL: `${id}+${login}@users.noreply.github.com`,
        },
        heavyWrapper: null,
      });
      const hostGate = createLeanDeliveryHostGate({
        projectId,
        repository,
        github,
        state: project.state,
        reviewObjects: historicalReviewObjects(git, options.paseoHome, projectId, repository),
      });
      const refused = "The Host delivery checkout or its verified settings changed.";

      async function ready() {
        try {
          if (!options.canRun() || !(await options.isManagedHost())) return false;
          const [current, record] = await Promise.all([
            readOwnerDelivery(),
            options.projects.get(projectId),
          ]);
          const next = checkoutConfig.safeParse(current?.checkout);
          if (
            !next.success ||
            next.data.name !== name ||
            JSON.stringify(next.data.links) !== JSON.stringify(links) ||
            record?.rootPath !== projectRoot ||
            record?.kind !== "git" ||
            record.archivedAt
          )
            return false;
          if (!(await canonicalPrivate(parent)) || !(await canonicalPrivate(logDir))) return false;
          if (!(await approvedArtifactLink(parent, links[0]?.target))) return false;
          return (
            (await hasRepositoryBinding(projectId, repository)) &&
            (await verifyGitCustody(git, parent, pool, checkout, remoteUrl))
          );
        } catch {
          return false;
        }
      }

      return {
        ready,
        logDir,
        stepTimeoutMs: 3 * 60 * 60 * 1_000,
        hostGate,
        lifecycle: null,
        checks: exactChecks(project),
        async notify() {
          if (!(await ready())) throw new Error(refused);
          await options.notifyOwner({
            title: "Factory beta scheduled",
            body: "Check Factory for the deployment time. Pause the project to cancel before deployment starts.",
          });
        },
        adapters: {
          host: {
            async run(request) {
              if (request.heavy) {
                return {
                  notStarted: "Use the project's approved heavy scheduler in the release command.",
                };
              }
              if (!(await ready())) return { notStarted: refused };
              if (!(await trackedLinksStayPrivate(git, checkout).catch(() => false))) {
                return {
                  notStarted: "The release checkout has an invalid or external tracked link.",
                };
              }
              return host.run({
                ...request,
                async authorizeLaunch() {
                  return (await ready()) && request.authorizeLaunch();
                },
              });
            },
          },
        },
        deliveryCheckouts: {
          host: {
            ...deliveryCheckout,
            async prepare(request) {
              if (!(await ready()) || (await metadata())?.default_branch !== defaultBranch) {
                return { notStarted: refused };
              }
              return deliveryCheckout.prepare(request);
            },
            async tags(patterns) {
              if (!(await ready())) throw new Error(refused);
              return deliveryCheckout.tags(patterns);
            },
            async pushTags(request) {
              if (!(await ready())) return { withheld: true };
              return deliveryCheckout.pushTags({
                ...request,
                async authorizePush(tags) {
                  return (await ready()) && request.authorizePush(tags);
                },
              });
            },
            async blob(file) {
              return (await ready()) ? deliveryCheckout.blob(file) : null;
            },
            async tag(tag) {
              return (await ready()) ? deliveryCheckout.tag(tag) : { notStarted: refused };
            },
            async commitRecords(request) {
              if (!(await ready()) || (await metadata())?.default_branch !== defaultBranch) {
                return { refused };
              }
              return deliveryCheckout.commitRecords({
                ...request,
                async authorizePush(input) {
                  return (
                    (await ready()) &&
                    (await branch.head()) === input.expectedHead &&
                    request.authorizePush(input)
                  );
                },
              });
            },
          },
        },
      };
    } catch {
      options.unavailable(
        projectId,
        "The Host could not verify the private delivery checkout or its GitHub authority.",
      );
      return null;
    }
  };
}
