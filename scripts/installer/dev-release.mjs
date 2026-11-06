// Dev releases: Dev's daemon built on the Host into <deployment>/dev-releases/<commit> and
// mounted read-only into Dev, so an upgrade restarts Dev's daemon on new code instead of
// rebuilding and recreating its image. The installer's upgrade (upgrade.mjs) imports this;
// the coordinator's upgrade runs it as a command from its own release. Every function takes
// `run(command, args, { timeout })`, which resolves to stdout and throws on failure.
// See docs/execution-installation.md#dev-releases.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[a-f0-9]{40}$/;
const RECEIPT = ".vorteo-dev-release.json";
const MOUNT = "/opt/vorteo/dev-releases";
/**
 * A change here needs a new image, or at least a recreated container, not just a new
 * release: the image's own files, and the Compose files a plain restart would not apply.
 */
export const DEV_IMAGE_INPUTS = [
  "docker/base",
  "docker/tailscale",
  "docker/multiplex/compose.yaml",
  "docker/multiplex/compose.gate.yaml",
];
/** Lifecycle files the installer keeps in a Dev deployment, from docker/multiplex. */
export const DEPLOYMENT_SCRIPTS = [
  "common.sh",
  "update.sh",
  "gate.sh",
  "connect.sh",
  "compose.gate.yaml",
];
const KEEP_NEWEST = 3;

export const releasesOf = (deployment) => path.join(deployment, "dev-releases");

function readEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value]),
  );
}

/** The release's receipt when it is complete and names its own commit, else null. */
export function devReleaseReceipt(deployment, commit) {
  try {
    const receipt = JSON.parse(
      readFileSync(path.join(releasesOf(deployment), commit, RECEIPT), "utf8"),
    );
    return receipt.format === 1 && receipt.sourceCommit === commit ? receipt : null;
  } catch {
    return null;
  }
}

/** The selected release's commit, or "none" when Dev runs its image's own daemon. */
export function currentDevRelease(deployment) {
  try {
    const target = readlinkSync(path.join(releasesOf(deployment), "current"));
    return COMMIT.test(target) ? target : "none";
  } catch {
    return "none";
  }
}

async function extract(run, git, source, commit, paths, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const archive = path.join(destination, "..", `${path.basename(destination)}.tar`);
  await run(git, [
    "-C",
    source,
    "archive",
    "--format=tar",
    `--output=${archive}`,
    commit,
    ...paths,
  ]);
  if (existsSync(archive)) {
    await run("tar", ["-xf", archive, "-C", destination], { timeout: 300_000 });
    rmSync(archive, { force: true });
  }
}

/**
 * Copies the commit's deployment scripts into the deployment, keeping each replaced file
 * once as <name>.previous. A changed compose file applies at Dev's next recreation.
 */
export async function refreshDeploymentScripts({ run, git, source, commit, deployment }) {
  const work = path.join(os.tmpdir(), `vorteo-dev-scripts-${randomUUID()}`);
  try {
    await extract(
      run,
      git,
      source,
      commit,
      DEPLOYMENT_SCRIPTS.map((name) => `docker/multiplex/${name}`),
      work,
    );
    const changed = [];
    for (const name of DEPLOYMENT_SCRIPTS) {
      const from = path.join(work, "docker/multiplex", name);
      const to = path.join(deployment, name);
      if (!existsSync(from) || statSync(from).size === 0) continue;
      if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
      if (existsSync(to)) copyFileSync(to, `${to}.previous`);
      // A new file renamed into place: bash reads a running script as it goes, so
      // rewriting it in place could run a mix of old and new bytes.
      const next = `${to}.next`;
      copyFileSync(from, next);
      chmodSync(next, name.endsWith(".sh") ? 0o700 : 0o600);
      renameSync(next, to);
      changed.push(name);
    }
    return changed;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Whether Dev can move to `commit` by swapping its release: its image advertises Dev
 * releases, the release folder is mounted read-only, and no image input changed since
 * the commit the image was built from. Otherwise the image must be rebuilt.
 */
export async function devUpgradeMode({ run, docker, git, source, commit, deployment }) {
  const image = (reason) => ({ mode: "image", reason });
  const instance = readEnv(path.join(deployment, ".env")).PASEO_INSTANCE;
  if (!instance) return image("Dev's deployment names no instance.");
  let labels;
  let mounts;
  try {
    const output = await run(docker, [
      "inspect",
      "--format",
      "{{json .Config.Labels}}\t{{json .Mounts}}",
      `${instance}-paseo-1`,
    ]);
    [labels, mounts] = output.trim().split("\t").map(JSON.parse);
  } catch {
    return image("Dev's container could not be inspected.");
  }
  if (labels?.["sh.vorteo.dev-release"] !== "v1")
    return image("Dev's image predates Dev releases.");
  if (!mounts?.some((mount) => mount.Destination === MOUNT && mount.RW === false))
    return image("Dev's container has no read-only release mount yet.");
  const built = labels["sh.vorteo.dev-image-commit"];
  if (!COMMIT.test(built ?? "")) return image("Dev's image does not record its commit.");
  try {
    const changed = await run(git, [
      "-C",
      source,
      "diff",
      "--name-only",
      built,
      commit,
      "--",
      ...DEV_IMAGE_INPUTS,
    ]);
    if (changed.trim()) return image(`The image's own files changed since ${built.slice(0, 12)}.`);
  } catch {
    return image(`The source does not contain the image's commit ${built.slice(0, 12)}.`);
  }
  return { mode: "release", reason: `Only Dev's daemon changed since ${built.slice(0, 12)}.` };
}

/** Workspaces the Dockerfile packs, in its order. */
const PACKED_WORKSPACES = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const HOST_ENTRY = "packages/server/dist/scripts/supervisor-entrypoint.js";
const HOST_WEB_UI = "packages/server/dist/server/web-ui/index.html";

/**
 * Packs the Host release built for `commit` into <work>/packs, so a Dev build installs the
 * Host's compiled packages instead of compiling them again in Linux. Their contents are
 * JavaScript and the web UI; native modules still build in the Linux install. Returns
 * { packs: null, reason } when no Host release matches: its installer marker must name
 * the commit and must not be a lab build of uncommitted changes.
 */
export async function packHostRelease({
  run,
  npm = "npm",
  node = process.execPath,
  hostRelease,
  commit,
  work,
}) {
  const refuse = (reason) => ({ packs: null, reason });
  if (!hostRelease) return refuse("No Host release is known.");
  let marker;
  try {
    marker = JSON.parse(readFileSync(path.join(hostRelease, ".installer-release.json"), "utf8"));
  } catch {
    return refuse("The Host release has no installer marker.");
  }
  if (marker.revision !== commit)
    return refuse(`The Host release was built for ${String(marker.revision).slice(0, 12)}.`);
  if (marker.lab)
    return refuse("The Host release is a lab build, which may hold uncommitted changes.");
  for (const file of [HOST_ENTRY, HOST_WEB_UI])
    if (!existsSync(path.join(hostRelease, file)))
      return refuse(`The Host release has no ${file}.`);
  const packs = path.join(work, "packs");
  try {
    await run(node, ["--check", path.join(hostRelease, HOST_ENTRY)]);
    mkdirSync(packs, { recursive: true, mode: 0o700 });
    for (const name of PACKED_WORKSPACES)
      await run(
        npm,
        ["pack", "--ignore-scripts", `--workspace=@getpaseo/${name}`, "--pack-destination", packs],
        { cwd: hostRelease, timeout: 300_000 },
      );
    const count = readdirSync(packs).filter((name) => name.endsWith(".tgz")).length;
    if (count !== PACKED_WORKSPACES.length) throw new Error(`packed ${count} packages`);
  } catch (error) {
    rmSync(packs, { recursive: true, force: true });
    return refuse(`Packing the Host release failed: ${error.message}`);
  }
  return { packs, reason: null };
}

/**
 * Runs one BuildKit build of the commit's Dockerfile from a `git archive`, with the Host
 * release's packages when one matches and the Dockerfile's own compile stages otherwise.
 */
async function dockerBuild(input, work, args) {
  const { run, docker, git, source, commit } = input;
  const context = path.join(work, "source");
  await extract(run, git, source, commit, [], context);
  const host = await packHostRelease({ ...input, work });
  await run(
    docker,
    [
      "build",
      ...args,
      "--build-arg",
      `PASEO_BUILD_COMMIT=${commit}`,
      ...(host.packs ? ["--build-context", `packs=${host.packs}`] : []),
      "-f",
      path.join(context, "docker/base/Dockerfile"),
      context,
    ],
    { timeout: 90 * 60_000 },
  );
  return host.packs ? "the Host release" : `source (${host.reason})`;
}

/**
 * Builds the commit's Dev release from the Dockerfile's dev-release stage, so it shares the
 * image's Node and cached layers, then moves it into place only once its receipt checks
 * out. Reuses an existing release. Returns the release folder and what it was packed from.
 */
export async function buildDevRelease(input) {
  const { commit, deployment } = input;
  if (!COMMIT.test(commit)) throw new Error(`${commit} is not a commit`);
  const root = releasesOf(deployment);
  const release = path.join(root, commit);
  if (devReleaseReceipt(deployment, commit)) return { release, packedFrom: "an existing release" };
  // Dev's daemon user reads it, and a umask or an earlier mkdir can leave it private.
  mkdirSync(root, { recursive: true, mode: 0o755 });
  chmodSync(root, 0o755);
  const work = path.join(os.tmpdir(), `vorteo-dev-release-${randomUUID()}`);
  const staging = path.join(root, `.staging-${commit}`);
  rmSync(staging, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
  try {
    const packedFrom = await dockerBuild(input, work, [
      "--target",
      "dev-release",
      "--output",
      `type=local,dest=${staging}`,
    ]);
    renameSync(staging, release);
    chmodSync(release, 0o755);
    if (!devReleaseReceipt(deployment, commit))
      throw new Error(`The Dev release for ${commit} has no valid receipt`);
    return { release, packedFrom };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Builds the commit's Dev image the same way; returns its image ID. */
export async function buildDevImage(input) {
  const work = path.join(os.tmpdir(), `vorteo-dev-image-${randomUUID()}`);
  const iid = path.join(work, "image.iid");
  try {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    // Tagged, so a dangling-image prune between the build and Dev's recreation keeps it.
    const packedFrom = await dockerBuild(input, work, [
      "--iidfile",
      iid,
      "--tag",
      `vorteo-dev:${input.commit}`,
    ]);
    return { image: readFileSync(iid, "utf8").trim(), packedFrom };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Removes old releases, keeping the selected one, the previous one and the newest three.
 * Only folders named by a commit are ever considered.
 */
export function pruneDevReleases(deployment) {
  const root = releasesOf(deployment);
  if (!existsSync(root)) return [];
  const keep = new Set(
    ["current", "previous"].map((name) => {
      try {
        return readlinkSync(path.join(root, name));
      } catch {
        return null;
      }
    }),
  );
  const releases = readdirSync(root)
    .filter((name) => COMMIT.test(name))
    .map((name) => ({ name, time: statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  const removed = [];
  for (const [index, { name }] of releases.entries()) {
    if (index < KEEP_NEWEST || keep.has(name)) continue;
    rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeout ?? 120_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.message = `${error.message}\n${String(stderr).slice(-4000)}`;
          reject(error);
        } else resolve(String(stdout));
      },
    );
  });
}

/**
 * The coordinator's entry: node dev-release.mjs <prepare|mode|refresh|build|image|current|prune>
 * --source S --commit C --deployment D [--host-release H] [--npm N] [--docker X] [--git G].
 * Prints one JSON line.
 */
async function main(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, "");
    if (!key || rest[index + 1] === undefined) throw new Error(`Missing value for ${rest[index]}`);
    options[key] = rest[index + 1];
  }
  const input = {
    run: runProcess,
    docker: options.docker ?? "docker",
    git: options.git ?? "git",
    npm: options.npm ?? "npm",
    hostRelease: options["host-release"],
    source: options.source,
    commit: options.commit,
    deployment: options.deployment,
  };
  if (!input.deployment) throw new Error("--deployment is required");
  switch (command) {
    case "prepare": {
      // Scripts first: the release swap needs this commit's update.sh.
      const refreshed = await refreshDeploymentScripts(input);
      return { refreshed, ...(await devUpgradeMode(input)) };
    }
    case "mode":
      return await devUpgradeMode(input);
    case "refresh":
      return { refreshed: await refreshDeploymentScripts(input) };
    case "build":
      return await buildDevRelease(input);
    case "image":
      return await buildDevImage(input);
    case "current":
      return { release: currentDevRelease(input.deployment) };
    case "prune":
      return { removed: pruneDevReleases(input.deployment) };
    default:
      throw new Error(`Unknown command ${command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
