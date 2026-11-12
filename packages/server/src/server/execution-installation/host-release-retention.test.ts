import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { setReleaseImmutable } from "./coordinator-bootstrap-release-seal.js";
import type { InstallationConfig } from "./config.js";
import { hostRetentionReferences } from "./source-updates.js";
import { claudeExecutableVersion } from "../agent/providers/claude/agent.js";
import {
  readSessionHostRelease,
  writeSessionHostRelease,
  acquireHostLock,
  SessionHostReleaseRemovedError,
} from "../session-host/host-files.js";
import { sessionHostReleaseRoot } from "../session-host/service.js";
import { releasePathsInProcessListing, releaseProcessPaths } from "./host-release-processes.js";
import {
  hostReleaseRetentionIdle,
  pruneHostReleases,
  removeReleaseTree,
  startHostReleaseRetention,
} from "./host-release-retention.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** Job folders 0 (oldest) to count-1 (newest), each with a release tree, plus unrelated folders. */
function fixture(count: number) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-retention-")));
  roots.push(base);
  const root = path.join(base, "reviewed-updates");
  mkdirSync(path.join(root, ".release-dependency-cache"), { recursive: true });
  mkdirSync(path.join(root, "source-updates"), { recursive: true });
  const release = (index: number) => path.join(root, id(index), "build-x");
  for (let index = 0; index < count; index += 1) {
    mkdirSync(path.join(release(index), "node_modules"), { recursive: true });
    writeFileSync(path.join(root, id(index), "admission.json"), "{}");
    const time = new Date(Date.UTC(2026, 9, 23, 0, index));
    utimesSync(path.join(root, id(index)), time, time);
  }
  const current = path.join(base, "current");
  symlinkSync(release(count - 1), current);
  return { base, root, release, current };
}

const setAside = (f: ReturnType<typeof fixture>, index: number) =>
  path.join(f.root, `.pruning-${id(index)}`);

/** A process whose working directory is `cwd`, running until the test ends. */
async function processIn(cwd: string, args: string[] = []): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)", ...args],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout!.once("data", resolve);
    child.once("error", reject);
  });
  return child;
}

test("retention keeps referenced and newest releases and removes the rest", async () => {
  const f = fixture(8);
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current, f.release(2), path.join(f.root, id(1)), "/elsewhere/release"],
    keepNewest: 2,
  });
  expect(removed.sort()).toEqual([id(0), id(3), id(4), id(5)]);
  for (const kept of [1, 2, 6, 7]) expect(existsSync(f.release(kept))).toBe(true);
  // Folders that are not job folders are never touched, even when unreferenced.
  expect(existsSync(path.join(f.root, ".release-dependency-cache"))).toBe(true);
  expect(existsSync(path.join(f.root, "source-updates"))).toBe(true);
});

test("one release that cannot be removed is reported and the rest continue", async () => {
  const f = fixture(5);
  const failed: string[] = [];
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    removeRelease: async (directory) => {
      if (directory.includes(id(1))) throw new Error("Operation not permitted");
      await rm(directory, { recursive: true, force: true });
    },
    onError: (folder) => failed.push(path.basename(folder)),
  });
  expect(failed).toEqual([id(1)]);
  expect(removed.sort()).toEqual([id(0), id(2), id(3)]);
  // A release whose deletion failed may be half gone. It stays set aside, where nothing can
  // start from it, and the next cleanup finishes the job.
  expect(existsSync(f.release(1))).toBe(false);
  expect(existsSync(setAside(f, 1))).toBe(true);
  expect(await pruneHostReleases({ releaseRoot: f.root, referenced: [f.current] })).toEqual([
    id(1),
  ]);
  expect(existsSync(setAside(f, 1))).toBe(false);
});

test("off macOS, release trees are removed without immutable-flag tooling", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    // chflags would fail on a missing path, so resolving proves it was not called.
    await expect(setReleaseImmutable(["/nonexistent/release"], false)).resolves.toBeUndefined();
    const f = fixture(4);
    const failed: string[] = [];
    const removed = await pruneHostReleases({
      releaseRoot: f.root,
      referenced: [f.current],
      keepNewest: 1,
      onError: (folder) => failed.push(path.basename(folder)),
    });
    expect(failed).toEqual([]);
    expect(removed.sort()).toEqual([id(0), id(1), id(2)]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("plain release trees are removed without the seal-aware walk", async () => {
  const f = fixture(1);
  const sealAware: string[] = [];
  await removeReleaseTree(f.release(0), async (directory) => {
    sealAware.push(directory);
  });
  expect(existsSync(f.release(0))).toBe(false);
  expect(sealAware).toEqual([]);
});

test.skipIf(process.platform !== "darwin")(
  "a tree that refuses plain deletion falls back to the seal-aware removal",
  async () => {
    const f = fixture(1);
    const locked = path.join(f.release(0), "locked.json");
    writeFileSync(locked, "{}");
    execFileSync("/usr/bin/chflags", ["uchg", locked]);
    const sealAware: string[] = [];
    try {
      await removeReleaseTree(f.release(0), async (directory) => {
        sealAware.push(directory);
        execFileSync("/usr/bin/chflags", ["-R", "nouchg", directory]);
        await rm(directory, { recursive: true, force: true });
      });
    } finally {
      if (existsSync(locked)) execFileSync("/usr/bin/chflags", ["nouchg", locked]);
    }
    expect(sealAware).toEqual([f.release(0)]);
    expect(existsSync(f.release(0))).toBe(false);
  },
);

test("cleanup runs after the caller returns, one at a time, with a receipt", async () => {
  const f = fixture(1);
  const receipt = path.join(f.base, "retention.json");
  const skipped = path.join(f.base, "skipped.json");
  let finish!: (note: string) => void;
  const prune = () => new Promise<string>((resolve) => (finish = resolve));
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  expect(startHostReleaseRetention(prune, receipt)).toBe(true);
  // The caller is not held: the cleanup is still running when this returns.
  expect(read(receipt)).toMatchObject({ status: "running" });
  expect(startHostReleaseRetention(async () => "unexpected", skipped)).toBe(false);
  expect(read(skipped)).toMatchObject({ status: "skipped" });
  finish(" Removed 4 old Host releases.");
  await hostReleaseRetentionIdle();
  expect(read(receipt)).toMatchObject({
    status: "finished",
    note: "Removed 4 old Host releases.",
  });
  // A failed cleanup is recorded and frees the next one.
  expect(
    startHostReleaseRetention(async () => {
      throw new Error("disk busy");
    }, receipt),
  ).toBe(true);
  await hostReleaseRetentionIdle();
  expect(read(receipt)).toMatchObject({ status: "failed", error: "disk busy" });
  expect(startHostReleaseRetention(async () => "", skipped)).toBe(true);
  await hostReleaseRetentionIdle();
});

test("retention keeps the release that holds the live update tooling", async () => {
  // Reviewed tooling selection points sourceUpdates.toolingDirectory into an old
  // release's scripts folder; removing it broke every later Host install.
  const f = fixture(6);
  const tooling = path.join(f.release(0), "scripts");
  mkdirSync(tooling);
  mkdirSync(path.join(f.release(1), "scripts"));
  // An installer-layout coordinator runs release 2 through its own link.
  const coordinatorLink = path.join(f.root, "..", "coordinator-current");
  symlinkSync(f.release(2), coordinatorLink);
  const config = {
    sourceUpdates: { currentReleaseLink: f.current, toolingDirectory: tooling },
    containerSourceUpdates: { toolingDirectory: path.join(f.release(1), "scripts") },
    deployment: { coordinator: { releaseLink: coordinatorLink } },
  } as unknown as Pick<
    InstallationConfig,
    "sourceUpdates" | "containerSourceUpdates" | "deployment"
  >;
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: hostRetentionReferences({
      config,
      previous: f.release(4),
      plans: [],
      unfinished: [],
    }),
    keepNewest: 1,
  });
  expect(removed.sort()).toEqual([id(3)]);
  expect(existsSync(f.release(2))).toBe(true);
  expect(existsSync(tooling)).toBe(true);
  expect(existsSync(f.release(1))).toBe(true);
});

test("retention keeps the release a running session host recorded", async () => {
  // The host outlives installs; deleting its release left it running on removed files.
  const f = fixture(6);
  const home = path.join(f.base, "home");
  expect(await readSessionHostRelease(home)).toBeNull();
  mkdirSync(path.join(home, "session-host"), { recursive: true });
  const socket = path.join(home, "session-host", "host.sock");
  const lock = await acquireHostLock(socket);
  // An older host has the same lock contract but publishes no release receipt.
  await expect(readSessionHostRelease(home)).rejects.toThrow();
  await writeSessionHostRelease(path.join(home, "session-host"), f.release(1));
  const receipt = path.join(home, "session-host", "release.json");
  const original = readFileSync(receipt, "utf8");
  await expect(acquireHostLock(socket)).rejects.toThrow("already serving");
  expect(readFileSync(receipt, "utf8")).toBe(original);
  const config = {
    sourceUpdates: { currentReleaseLink: f.current, toolingDirectory: f.current },
  } as unknown as Pick<
    InstallationConfig,
    "sourceUpdates" | "containerSourceUpdates" | "deployment"
  >;
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: hostRetentionReferences({
      config,
      previous: f.release(4),
      plans: [],
      unfinished: [],
      sessionHostRelease: await readSessionHostRelease(home),
    }),
    keepNewest: 1,
  });
  expect(removed.sort()).toEqual([id(0), id(2), id(3)]);
  expect(existsSync(f.release(1))).toBe(true);
  // A replacement can reuse this PID. Its newly acquired real inode generation
  // invalidates the old receipt until it publishes its own canonical root.
  await lock.release();
  const replacement = await acquireHostLock(socket);
  await expect(readSessionHostRelease(home)).rejects.toThrow("another lock generation");
  expect(existsSync(f.release(1))).toBe(true);
  await writeSessionHostRelease(path.join(home, "session-host"), f.release(5));
  const afterReplacement = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: hostRetentionReferences({
      config,
      previous: f.release(4),
      plans: [],
      unfinished: [],
      sessionHostRelease: await readSessionHostRelease(home),
    }),
    keepNewest: 1,
  });
  expect(afterReplacement).toEqual([id(1)]);
  expect(existsSync(f.release(5))).toBe(true);
  await replacement.release();
  // Removing a lock does not prove that its retained owner has exited.
  await expect(readSessionHostRelease(home)).rejects.toThrow("absence evidence");
});

test.each([
  "missing",
  "invalid",
  "unknown-root",
  "write-failure",
  "malformed-lock",
  "missing-lock",
])("retention refuses a live host with %s release evidence", async (mode) => {
  const f = fixture(5);
  const home = path.join(f.base, "home");
  const directory = path.join(home, "session-host");
  mkdirSync(directory, { recursive: true });
  const lock = await acquireHostLock(path.join(directory, "host.sock"));
  const receipt = path.join(directory, "release.json");
  try {
    if (mode === "write-failure") {
      mkdirSync(receipt);
      await expect(writeSessionHostRelease(directory, f.release(1))).rejects.toThrow();
    } else if (mode !== "missing") {
      await writeSessionHostRelease(directory, f.release(1));
      if (mode === "malformed-lock") {
        const deadPid = 2147483647;
        expect(() => process.kill(deadPid, 0)).toThrow();
        writeFileSync(
          path.join(directory, "host.sock.lock"),
          `${deadPid} invalid-holder-record\n`,
          { mode: 0o600 },
        );
      } else if (mode === "missing-lock") {
        rmSync(path.join(directory, "host.sock.lock"));
      } else if (mode === "invalid") writeFileSync(receipt, "{malformed receipt", { mode: 0o600 });
      else {
        const value = JSON.parse(readFileSync(receipt, "utf8"));
        value.releaseRoot = path.join(f.base, "unavailable-root");
        writeFileSync(receipt, JSON.stringify(value), { mode: 0o600 });
      }
    }
    const cleanup = async () => {
      const release = await readSessionHostRelease(home);
      return pruneHostReleases({
        releaseRoot: f.root,
        referenced: [f.current, ...(release ? [release] : [])],
        keepNewest: 1,
      });
    };
    await expect(cleanup()).rejects.toThrow();
    for (let index = 0; index < 5; index++) expect(existsSync(f.release(index))).toBe(true);
  } finally {
    await lock.release();
  }
});

test("failed Claude executable probes are cached until the executable changes", async () => {
  const f = fixture(1);
  const executable = path.join(f.base, "claude-probe");
  writeFileSync(executable, '#!/bin/sh\nprintf . >> "$0.calls"\nexit 1\n', { mode: 0o700 });
  expect(await claudeExecutableVersion(executable)).toBeNull();
  expect(await claudeExecutableVersion(executable)).toBeNull();
  expect(readFileSync(`${executable}.calls`, "utf8")).toBe(".");
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf . >> "$0.calls"\nprintf "2.1.99 (Claude Code)\\n"\n',
    { mode: 0o700 },
  );
  expect(await claudeExecutableVersion(executable)).toBe("2.1.99");
  expect(readFileSync(`${executable}.calls`, "utf8")).toBe("..");
});

test("retention keeps releases a preview broker plan or configuration names", async () => {
  // A deployment plan pins candidate files inside the release that prepared it. Removing
  // that release left the plan undeployable and previews down.
  const f = fixture(8);
  const candidate = (index: number) => ({
    targets: [
      {
        root: "/elsewhere/preview",
        files: {
          "https_broker.py": {
            candidate: { path: path.join(f.release(index), "scripts/https_broker.py") },
          },
        },
      },
    ],
  });
  const job = (index: number, status: string) => ({
    target: "preview-broker-deployment",
    status,
    plan: candidate(index),
  });
  const config = {
    sourceUpdates: { currentReleaseLink: f.current, toolingDirectory: f.current },
    previewBrokerDeployment: {
      worker: { path: path.join(f.release(4), "scripts/worker.py"), sha256: "0" },
    },
    previewBroker: { consumerFiles: [{ path: path.join(f.release(5), "scripts/consumer.py") }] },
  } as unknown as Parameters<typeof hostRetentionReferences>[0]["config"];
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: hostRetentionReferences({
      config,
      previous: f.release(7),
      plans: [],
      unfinished: [],
      lifecycle: [
        job(0, "pending"),
        job(1, "failed"),
        job(2, "succeeded"),
        job(3, "rejected"),
        // Another target's plan is not a broker plan, whatever paths it holds.
        { target: "host", status: "pending", plan: candidate(6) },
      ],
    }),
    keepNewest: 1,
  });
  expect(removed.sort()).toEqual([id(2), id(3), id(6)]);
  for (const kept of [0, 1, 4, 5, 7]) expect(existsSync(f.release(kept))).toBe(true);
});

test("process listings name releases by working directory, executable and command line", () => {
  const root = "/data/releases";
  const paths = releasePathsInProcessListing(root, {
    files: [
      "p41",
      "fcwd",
      `n${root}/${id(1)}/build-a/packages/server`,
      "ftxt",
      `n${root}/.pruning-${id(2)}/build-b/node_modules/pty/pty.node`,
      "n/usr/lib/dyld",
      `n${root}-other/${id(9)}/build`,
    ].join("\n"),
    commands: [
      `/usr/bin/node ${root}/${id(3)}/build-c/packages/server/dist/daemon-worker.js --flag`,
      `node --import=${root}/${id(4)}/build-d/loader.js /elsewhere/main.js`,
      "/usr/bin/node /elsewhere/main.js",
    ].join("\n"),
  });
  expect(paths.sort()).toEqual([
    `${root}/.pruning-${id(2)}/build-b/node_modules/pty/pty.node`,
    `${root}/${id(1)}/build-a/packages/server`,
    `${root}/${id(3)}/build-c/packages/server/dist/daemon-worker.js`,
    `${root}/${id(4)}/build-d/loader.js`,
  ]);
});

test("retention keeps every release a running process executes from", async () => {
  // A daemon worker, a session host or a provider CLI can run from any old release.
  const f = fixture(6);
  await processIn(path.join(f.release(1), "node_modules"));
  // This one runs elsewhere and only names its release on the command line.
  await processIn(f.base, [path.join(f.release(2), "entry.js")]);
  const live = await releaseProcessPaths(f.root);
  expect(live).toContain(path.join(f.release(1), "node_modules"));
  expect(live).toContain(path.join(f.release(2), "entry.js"));
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current, ...live],
    keepNewest: 1,
  });
  expect(removed.sort()).toEqual([id(0), id(3), id(4)]);
  expect(existsSync(f.release(1))).toBe(true);
  expect(existsSync(f.release(2))).toBe(true);
}, 60_000);

test("a process that starts after the snapshot gets its release back", async () => {
  // The race that suspended cleanup: nothing uses release 1 when references are read, and
  // a process starts from it before deletion. Setting the folder aside first means the
  // process is either visible to the check that follows or could not have started at all.
  const f = fixture(5);
  const snapshot = [f.current, ...(await releaseProcessPaths(f.root))];
  const late = await processIn(path.join(f.release(1), "node_modules"));
  const kept: string[] = [];
  let duringCheck: boolean | null = null;
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: snapshot,
    keepNewest: 1,
    inUse: async () => {
      // While the check runs, no candidate can be started from.
      duringCheck = existsSync(f.release(1)) || existsSync(f.release(0));
      return releaseProcessPaths(f.root);
    },
    onInUse: (folder) => kept.push(path.basename(folder)),
  });
  expect(duringCheck).toBe(false);
  expect(kept).toEqual([id(1)]);
  expect(removed.sort()).toEqual([id(0), id(2), id(3)]);
  expect(existsSync(path.join(f.release(1), "node_modules"))).toBe(true);
  expect(existsSync(setAside(f, 1))).toBe(false);
  expect(late.exitCode).toBeNull();
}, 60_000);

test("a release selected after the snapshot is put back, not deleted", async () => {
  // A rollback moves the release link while cleanup runs. The link dangles while its target
  // is set aside; it still names the folder it points into.
  const f = fixture(5);
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    inUse: async () => {
      unlinkSync(f.current);
      symlinkSync(f.release(2), f.current);
      return [path.join(f.current, "packages/server")];
    },
  });
  expect(removed.sort()).toEqual([id(0), id(1), id(3)]);
  expect(realpathSync(f.current)).toBe(f.release(2));
});

test("cleanup that cannot read what is in use puts every release back", async () => {
  const f = fixture(5);
  const failed: string[] = [];
  await expect(
    pruneHostReleases({
      releaseRoot: f.root,
      referenced: [f.current],
      keepNewest: 1,
      inUse: async () => {
        throw new Error("process listing failed");
      },
      onError: (folder) => failed.push(folder),
    }),
  ).rejects.toThrow("process listing failed");
  expect(failed).toEqual([]);
  for (let index = 0; index < 5; index++) {
    expect(existsSync(f.release(index))).toBe(true);
    expect(existsSync(setAside(f, index))).toBe(false);
  }
});

test("a folder left set aside is put back when something still uses it", async () => {
  const f = fixture(4);
  renameSync(path.join(f.root, id(0)), setAside(f, 0));
  renameSync(path.join(f.root, id(1)), setAside(f, 1));
  const kept: string[] = [];
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    // The kernel reports a renamed working directory under its new name.
    inUse: async () => [path.join(setAside(f, 0), "build-x/packages/server")],
    onInUse: (folder) => kept.push(path.basename(folder)),
  });
  expect(removed).toEqual([id(1)]);
  expect(kept).toEqual([id(0)]);
  expect(existsSync(f.release(0))).toBe(true);
});

test("a session host starting during cleanup is kept or refuses to start", async () => {
  const f = fixture(5);
  const home = path.join(f.base, "home");
  const directory = path.join(home, "session-host");
  mkdirSync(directory, { recursive: true });
  const lock = await acquireHostLock(path.join(directory, "host.sock"));
  const references = async () => {
    const release = await readSessionHostRelease(home);
    return [f.current, ...(release ? [release] : [])];
  };
  try {
    // Cleanup wins: the release is set aside before the host publishes. The host finds its
    // release gone and fails its start instead of serving from removed files.
    let refused: unknown;
    const removed = await pruneHostReleases({
      releaseRoot: f.root,
      referenced: [f.current],
      keepNewest: 4,
      inUse: async () => {
        refused = await writeSessionHostRelease(directory, f.release(0)).catch((error) => error);
        return [f.current];
      },
    });
    expect(refused).toBeInstanceOf(SessionHostReleaseRemovedError);
    expect(removed).toEqual([id(0)]);

    // The host wins: it publishes after the references were read and before its release is
    // set aside. The second read cannot confirm the receipt's release, so nothing is deleted.
    const snapshot = [f.current];
    await writeSessionHostRelease(directory, f.release(1));
    await expect(
      pruneHostReleases({
        releaseRoot: f.root,
        referenced: snapshot,
        keepNewest: 3,
        inUse: references,
      }),
    ).rejects.toThrow();
    expect(existsSync(f.release(1))).toBe(true);
    expect(await readSessionHostRelease(home)).toBe(f.release(1));

    // Once the receipt is part of the references, the release is simply kept.
    const afterReceipt = await pruneHostReleases({
      releaseRoot: f.root,
      referenced: await references(),
      keepNewest: 1,
      inUse: references,
    });
    expect(afterReceipt.sort()).toEqual([id(2), id(3)]);
    expect(existsSync(f.release(1))).toBe(true);
  } finally {
    await lock.release();
  }
});

test("the session host names the release its own code was loaded from", () => {
  const release = "/data/releases/reviewed-updates/job/build-x";
  expect(
    sessionHostReleaseRoot(`${release}/packages/server/dist/server/server/session-host/service.js`),
  ).toBe(release);
  expect(
    sessionHostReleaseRoot("/src/vorteo/packages/server/src/server/session-host/service.ts"),
  ).toBeNull();
});
