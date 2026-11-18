import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { setReleaseImmutable } from "./coordinator-bootstrap-release-seal.js";
import type { InstallationConfig } from "./config.js";
import { hostRetentionReferences } from "./source-updates.js";
import { claudeExecutableVersion } from "../agent/providers/claude/agent.js";
import {
  readSessionHostRelease,
  writeSessionHostRelease,
  acquireHostLock,
  SessionHostReleaseRemovedError,
  SessionHostFileError,
} from "../session-host/host-files.js";
import { sessionHostReleaseRoot } from "../session-host/service.js";
import { linkedReleasePathsInCommands, releaseProcessPaths } from "./host-release-processes.js";
import {
  hostReleaseRetentionIdle,
  pruneHostReleases,
  recordLinkTargets,
  ReleaseRootLockedError,
  removeReleaseTree,
  resolveReference,
  restoreSetAsideReleases,
  startHostReleaseRetention,
  type HostReleaseCleanupPlan,
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

/**
 * The folder a cleanup set aside or started deleting for job `index`, as it is named on disk
 * now: `<prefix>-<job id>-<run nonce>`, or the form without a nonce, which earlier cleanups
 * used and tests create directly. Falls back to that form when neither exists.
 */
function namedEntry(f: ReturnType<typeof fixture>, prefix: string, index: number): string {
  const base = `${prefix}-${id(index)}`;
  const found = readdirSync(f.root).find(
    (name) =>
      name === base || (/^-[0-9a-f]{16}$/.test(name.slice(base.length)) && name.startsWith(base)),
  );
  return path.join(f.root, found ?? base);
}
const setAside = (f: ReturnType<typeof fixture>, index: number) => namedEntry(f, ".pruning", index);
const deleting = (f: ReturnType<typeof fixture>, index: number) =>
  namedEntry(f, ".deleting", index);

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
  // A release whose deletion failed may be half gone. It keeps a name that is never put
  // back, where nothing can start from it, and the next cleanup finishes the job.
  expect(existsSync(f.release(1))).toBe(false);
  expect(existsSync(setAside(f, 1))).toBe(false);
  expect(existsSync(deleting(f, 1))).toBe(true);
  expect(await pruneHostReleases({ releaseRoot: f.root, referenced: [f.current] })).toEqual([
    id(1),
  ]);
  expect(existsSync(deleting(f, 1))).toBe(false);
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

test("folders an earlier cleanup left set aside are put back first, even when the in-use read fails", async () => {
  // A coordinator died between setting folders aside and its in-use check.
  const f = fixture(4);
  renameSync(path.join(f.root, id(0)), setAside(f, 0));
  const restored: string[] = [];
  await expect(
    pruneHostReleases({
      releaseRoot: f.root,
      referenced: [f.current],
      keepNewest: 1,
      inUse: async () => {
        throw new Error("process listing failed");
      },
      onRestored: (folder) => restored.push(path.basename(folder)),
    }),
  ).rejects.toThrow("process listing failed");
  expect(restored[0]).toBe(id(0));
  for (let index = 0; index < 4; index++) {
    expect(existsSync(f.release(index))).toBe(true);
    expect(existsSync(setAside(f, index))).toBe(false);
  }
  // Coordinator start runs the same pass on its own.
  renameSync(path.join(f.root, id(1)), setAside(f, 1));
  expect(await restoreSetAsideReleases(f.root)).toEqual([id(1)]);
  expect(existsSync(f.release(1))).toBe(true);
});

test("deletion never follows a folder swapped for a link while it is being removed", async () => {
  const f = fixture(2);
  renameSync(path.join(f.root, id(0)), deleting(f, 0));
  for (const child of ["a", "b"]) mkdirSync(path.join(deleting(f, 0), child));
  // Whatever the link points at has the same child names, each holding something precious.
  const outside = path.join(f.base, "outside");
  for (const child of ["a", "b", "build-x"]) {
    mkdirSync(path.join(outside, child), { recursive: true });
    writeFileSync(path.join(outside, child, "precious"), "keep");
  }
  let swapped = false;
  const failed: string[] = [];
  await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    removeRelease: async (directory) => {
      await removeReleaseTree(directory);
      if (swapped) return;
      swapped = true;
      renameSync(deleting(f, 0), path.join(f.base, "moved"));
      symlinkSync(outside, deleting(f, 0));
    },
    onError: (folder) => failed.push(path.basename(folder)),
  });
  expect(swapped).toBe(true);
  expect(failed).toEqual([id(0)]);
  for (const child of ["a", "b", "build-x"])
    expect(readFileSync(path.join(outside, child, "precious"), "utf8")).toBe("keep");
});

test("the newest releases are chosen by when their jobs started, not folder times", async () => {
  // Removing a child touches a folder's time; job 0 started last despite its old folder time.
  const f = fixture(4);
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    startedAt: new Map([
      [id(0), Date.UTC(2026, 10, 1)],
      [id(1), Date.UTC(2026, 9, 1)],
    ]),
  });
  expect(removed.sort()).toEqual([id(1), id(2)]);
  expect(existsSync(f.release(0))).toBe(true);
});

test("recent release link targets are remembered across cleanups", async () => {
  const f = fixture(8);
  const historyFile = path.join(f.base, "release-link-history.json");
  const coordinator = path.join(f.base, "coordinator-current");
  symlinkSync(f.release(0), coordinator);
  for (const index of [1, 2, 3, 4, 5, 6]) {
    rmSync(f.current);
    symlinkSync(f.release(index), f.current);
    await recordLinkTargets({ releaseRoot: f.root, links: [f.current, coordinator], historyFile });
  }
  // The newest five distinct targets, the ones the links name now first.
  expect(JSON.parse(readFileSync(historyFile, "utf8")).targets).toEqual([
    id(6),
    id(0),
    id(5),
    id(4),
    id(3),
  ]);
  writeFileSync(historyFile, '{"version":1,"targets":["../escape"]}');
  await expect(
    recordLinkTargets({ releaseRoot: f.root, links: [f.current], historyFile }),
  ).rejects.toThrow("malformed");
});

test("retention keeps the releases the served interface comes from", async () => {
  // Publication pointing webDirectory or webDistDir into a job folder must keep it.
  const f = fixture(4);
  const config = {
    sourceUpdates: {
      currentReleaseLink: f.current,
      toolingDirectory: f.current,
      webDirectory: path.join(f.release(0), "web-ui"),
    },
    webDistDir: path.join(f.release(1), "packages/server/dist/server/web-ui"),
  } as unknown as Pick<
    InstallationConfig,
    "sourceUpdates" | "containerSourceUpdates" | "deployment" | "webDistDir"
  >;
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: hostRetentionReferences({
      config,
      previous: f.release(3),
      plans: [],
      unfinished: [],
    }),
    keepNewest: 1,
  });
  expect(removed).toEqual([id(2)]);
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

test("everything in use is put back before anything is deleted", async () => {
  // Deleting a backlog takes minutes. A release that came into use must not stay hidden for
  // that long, or for good if the cleanup dies part way through.
  const f = fixture(6);
  const kept: string[] = [];
  const hiddenDuringDeletion: string[] = [];
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    // The last candidate in deletion order is the one in use.
    inUse: async () => [path.join(setAside(f, 4), "build-x"), f.release(0)],
    onInUse: (folder) => kept.push(path.basename(folder)),
    removeRelease: async (directory) => {
      for (const index of [0, 4])
        if (!existsSync(f.release(index)) || existsSync(setAside(f, index)))
          hiddenDuringDeletion.push(id(index));
      await rm(directory, { recursive: true, force: true });
    },
  });
  expect(hiddenDuringDeletion).toEqual([]);
  expect(kept.sort()).toEqual([id(0), id(4)]);
  expect(removed.sort()).toEqual([id(1), id(2), id(3)]);
});

test("a half-deleted release is never put back, whatever names it", async () => {
  const f = fixture(4);
  // An earlier cleanup died while deleting release 0: part of the tree is gone.
  renameSync(path.join(f.root, id(0)), deleting(f, 0));
  rmSync(path.join(deleting(f, 0), "build-x", "node_modules"), { recursive: true });
  const kept: string[] = [];
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    // A link, a receipt and a process all still name it, by both of its names.
    referenced: [f.current, f.release(0), path.join(deleting(f, 0), "build-x")],
    inUse: async () => [f.release(0), path.join(deleting(f, 0), "build-x/packages/server")],
    onInUse: (folder) => kept.push(folder),
  });
  expect(removed).toEqual([id(0)]);
  expect(kept).toEqual([]);
  expect(existsSync(f.release(0))).toBe(false);
  expect(existsSync(deleting(f, 0))).toBe(false);

  // A deletion that fails after the tree left its restorable name stays unrestorable.
  const again = fixture(3);
  await pruneHostReleases({
    releaseRoot: again.root,
    referenced: [again.current],
    keepNewest: 1,
    removeRelease: async () => {
      throw new Error("interrupted");
    },
    onError: () => undefined,
  });
  expect(existsSync(setAside(again, 0))).toBe(false);
  expect(existsSync(deleting(again, 0))).toBe(true);
  await pruneHostReleases({
    releaseRoot: again.root,
    referenced: [again.current, again.release(0)],
    keepNewest: 1,
    inUse: async () => [again.release(0)],
  });
  expect(existsSync(again.release(0))).toBe(false);
  expect(existsSync(deleting(again, 0))).toBe(false);
});

test("a set-aside copy beside its job folder is removed and the job folder is left alone", async () => {
  const f = fixture(5);
  // Both names exist for jobs 0 and 1; the copies cannot be put back.
  for (const index of [0, 1]) {
    mkdirSync(path.join(setAside(f, index), "build-old"), { recursive: true });
  }
  const leftovers: string[] = [];
  const failed: string[] = [];
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    // A process still runs from the copy of job 1, under the name the kernel reports.
    inUse: async () => [path.join(setAside(f, 1), "build-old")],
    onLeftover: (folder) => leftovers.push(path.basename(folder)),
    onError: (folder) => failed.push(path.basename(folder)),
  });
  // Unshadowed old releases go as usual; the shadowed job folders wait for the next cleanup.
  expect(removed.sort()).toEqual([id(2), id(3)]);
  expect(leftovers).toEqual([`.pruning-${id(0)}`]);
  expect(failed).toEqual([`.pruning-${id(1)}`]);
  expect(existsSync(setAside(f, 0))).toBe(false);
  expect(existsSync(setAside(f, 1))).toBe(true);
  expect(existsSync(f.release(0))).toBe(true);
  expect(existsSync(f.release(1))).toBe(true);
  // With the copy gone, job 0 is an ordinary candidate again.
  expect(
    await pruneHostReleases({ releaseRoot: f.root, referenced: [f.current], keepNewest: 1 }),
  ).toEqual([id(0)]);
});

test("only a missing release fails a session host start", async () => {
  const f = fixture(2);
  const directory = path.join(f.base, "home", "session-host");
  mkdirSync(directory, { recursive: true });
  const lock = await acquireHostLock(path.join(directory, "host.sock"));
  try {
    // A release reached through a link exists but is not canonical: the old refusal, which
    // the host logs as a warning before it carries on.
    const viaLink = await writeSessionHostRelease(directory, f.current).catch((error) => error);
    expect(viaLink).toBeInstanceOf(SessionHostFileError);
    expect(viaLink).not.toBeInstanceOf(SessionHostReleaseRemovedError);
    await expect(
      writeSessionHostRelease(directory, path.join(f.root, id(9), "build-x")),
    ).rejects.toBeInstanceOf(SessionHostReleaseRemovedError);
  } finally {
    await lock.release();
  }
});

/** A promise and the function that settles it, for pausing a cleanup at a chosen point. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** What the lock records for a process: `ps` start time in the same locale as the code. */
function processStart(pid: number): string {
  return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
    .toString()
    .trim();
}

test("review: overlapping cleanups and a startup restore never delete a folder another cleanup protects", async () => {
  // Reviewer's interleaving, with B and the startup restore in an independent module instance,
  // so nothing in-memory serializes them: A sets X aside and pauses in its in-use read; the
  // restore and cleanup B then run against the same root.
  const f = fixture(4);
  const keep = [1, 2, 3].map((index) => path.join(f.root, id(index)));
  const aPaused = gate();
  const aResume = gate();
  const a = pruneHostReleases({
    releaseRoot: f.root,
    referenced: keep,
    keepNewest: 1,
    inUse: async () => {
      aPaused.open();
      await aResume.opened;
      return [];
    },
  });
  await aPaused.opened;
  vi.resetModules();
  const other = await import("./host-release-retention.js");
  expect(other.pruneHostReleases).not.toBe(pruneHostReleases);
  // The restore leaves A's folder set aside, so nothing can start from X meanwhile.
  expect(await other.restoreSetAsideReleases(f.root)).toBeNull();
  expect(existsSync(f.release(0))).toBe(false);
  expect(existsSync(setAside(f, 0))).toBe(true);
  // B, which would see X in use, cannot start, so it never sets X aside for A to consume.
  let bInUseRead = false;
  await expect(
    other.pruneHostReleases({
      releaseRoot: f.root,
      referenced: keep,
      keepNewest: 1,
      inUse: async () => {
        bInUseRead = true;
        return [f.release(0)];
      },
    }),
  ).rejects.toMatchObject({ name: "ReleaseRootLockedError" });
  expect(bInUseRead).toBe(false);
  aResume.open();
  // A deletes only what its own evidence, gathered while X stayed hidden, found unused.
  expect(await a).toEqual([id(0)]);
  // The lock is released: the next cleanup runs.
  await expect(
    other.pruneHostReleases({ releaseRoot: f.root, referenced: keep, keepNewest: 1 }),
  ).resolves.toEqual([]);
});

test("a cleanup never renames or deletes a set-aside folder that is not the one it set aside", async () => {
  // Defence in depth beside the lock: something bypassing it puts A's folder back and leaves
  // a different folder under A's set-aside name.
  const f = fixture(3);
  const failed: string[] = [];
  let impostor = "";
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    inUse: async () => {
      impostor = setAside(f, 0);
      renameSync(impostor, path.join(f.root, id(0)));
      mkdirSync(impostor);
      writeFileSync(path.join(impostor, "precious"), "keep");
      return [];
    },
    onError: (folder) => failed.push(path.basename(folder)),
  });
  expect(removed).toEqual([id(1)]);
  expect(failed).toEqual([id(0)]);
  expect(readFileSync(path.join(impostor, "precious"), "utf8")).toBe("keep");
  expect(existsSync(f.release(0))).toBe(true);
});

test("a cleanup lock held by a live process is respected, and a stale one is taken over", async () => {
  const f = fixture(3);
  const lock = path.join(f.root, ".cleanup.lock");
  const holder = await processIn(f.base);
  writeFileSync(lock, JSON.stringify({ pid: holder.pid, start: processStart(holder.pid!) }));
  await expect(
    pruneHostReleases({ releaseRoot: f.root, referenced: [f.current], keepNewest: 1 }),
  ).rejects.toBeInstanceOf(ReleaseRootLockedError);
  expect(await restoreSetAsideReleases(f.root)).toBeNull();
  // An unreadable lock, such as one being written, is never assumed free.
  writeFileSync(lock, "{");
  await expect(
    pruneHostReleases({ releaseRoot: f.root, referenced: [f.current], keepNewest: 1 }),
  ).rejects.toBeInstanceOf(ReleaseRootLockedError);
  // The holder exits: its lock is stale.
  writeFileSync(lock, JSON.stringify({ pid: holder.pid, start: processStart(holder.pid!) }));
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  expect(existsSync(f.release(0))).toBe(true);
  expect(
    await pruneHostReleases({ releaseRoot: f.root, referenced: [f.current], keepNewest: 2 }),
  ).toEqual([id(0)]);
  expect(existsSync(lock)).toBe(false);
  // A reused process ID: alive, but started at another time, so not the holder.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start: "Thu Jan  1 00:00:00 1970" }));
  expect(await restoreSetAsideReleases(f.root)).toEqual([]);
  expect(existsSync(lock)).toBe(false);
});

// Root searches any directory whatever its mode, so a mode-000 directory raises no EACCES.
test.skipIf(process.getuid?.() === 0)(
  "review: a reference that cannot be resolved for any reason but absence stops the cleanup",
  async () => {
    // EACCES on the only link to a release must not read as a missing path.
    const f = fixture(3);
    const sealed = path.join(f.base, "sealed");
    mkdirSync(sealed);
    symlinkSync(f.release(0), path.join(sealed, "link"));
    const reference = path.join(sealed, "link", "packages");
    chmodSync(sealed, 0o000);
    try {
      await expect(resolveReference(reference)).rejects.toMatchObject({ code: "EACCES" });
      await expect(
        linkedReleasePathsInCommands(f.root, `/usr/bin/node ${reference}/main.js`),
      ).rejects.toMatchObject({ code: "EACCES" });
      await expect(
        pruneHostReleases({
          releaseRoot: f.root,
          referenced: [f.current, reference],
          keepNewest: 1,
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
      await expect(
        pruneHostReleases({
          releaseRoot: f.root,
          referenced: [f.current],
          keepNewest: 1,
          inUse: async () => [reference],
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
      // Nothing was deleted, and nothing stays set aside.
      for (const index of [0, 1, 2]) expect(existsSync(f.release(index))).toBe(true);
      // Absence still continues lexically.
      expect(await resolveReference(path.join(f.base, "missing", "x"))).toBe(
        path.join(f.base, "missing", "x"),
      );
    } finally {
      chmodSync(sealed, 0o755);
    }
  },
);

test("an oversized release link history skips the cleanup", async () => {
  const f = fixture(2);
  const historyFile = path.join(f.base, "release-link-history.json");
  writeFileSync(historyFile, JSON.stringify({ version: 1, targets: [], pad: "x".repeat(70_000) }));
  await expect(
    recordLinkTargets({ releaseRoot: f.root, links: [f.current], historyFile }),
  ).rejects.toThrow("too large");
});

test("a set-aside copy beside a recreated, referenced job folder is kept", async () => {
  // A crash left the real release under its set-aside name and something recreated the job
  // folder. Only the job folder is referenced, yet the copy may be the release in use.
  const f = fixture(4);
  writeFileSync(path.join(f.release(0), "original"), "real");
  const copy = path.join(f.root, `.pruning-${id(0)}-${"a".repeat(16)}`);
  renameSync(path.join(f.root, id(0)), copy);
  mkdirSync(f.release(0), { recursive: true });
  const failed: string[] = [];
  const leftovers: string[] = [];
  await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current, f.release(0)],
    keepNewest: 1,
    onError: (folder) => failed.push(path.basename(folder)),
    onLeftover: (folder) => leftovers.push(path.basename(folder)),
  });
  expect(leftovers).toEqual([]);
  expect(failed).toEqual([path.basename(copy)]);
  expect(readFileSync(path.join(copy, "build-x", "original"), "utf8")).toBe("real");
  expect(existsSync(f.release(0))).toBe(true);
});

test("a set-aside copy that a reference names directly is kept", async () => {
  // Nothing names the job folder, and the copy is never set aside again, so only the
  // reference check on the copy's own name protects it.
  const f = fixture(4);
  const copy = path.join(f.root, `.pruning-${id(0)}-${"b".repeat(16)}`);
  mkdirSync(path.join(copy, "build-old"), { recursive: true });
  await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current, path.join(copy, "build-old")],
    keepNewest: 1,
    onError: () => undefined,
  });
  expect(existsSync(path.join(copy, "build-old"))).toBe(true);
  // Job 0 itself is shadowed by the copy and left for a later cleanup.
  expect(existsSync(f.release(0))).toBe(true);
});

test("a session host whose release disappears right after it publishes fails its start", async () => {
  // The second check: cleanup set the release aside between the host's first look and its
  // receipt. Simulated by moving the job folder the moment the receipt lands.
  const f = fixture(2);
  const directory = path.join(f.base, "home", "session-host");
  mkdirSync(directory, { recursive: true });
  vi.resetModules();
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const rename = async (from: string, to: string) => {
      await actual.rename(from, to);
      if (path.basename(to) === "release.json")
        await actual.rename(path.join(f.root, id(0)), path.join(f.root, `.pruning-${id(0)}`));
    };
    return { ...actual, default: { ...actual, rename }, rename };
  });
  try {
    const files = await import("../session-host/host-files.js");
    const lock = await files.acquireHostLock(path.join(directory, "host.sock"));
    try {
      await expect(files.writeSessionHostRelease(directory, f.release(0))).rejects.toBeInstanceOf(
        files.SessionHostReleaseRemovedError,
      );
      expect(existsSync(path.join(directory, "release.json"))).toBe(true);
    } finally {
      await lock.release();
    }
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
});

test("deletion stops when the release root is reached through a link", async () => {
  // An ancestor swapped for a link leaves the folder's device and inode unchanged; only the
  // canonical path check sees that removal now goes through the link.
  const f = fixture(2);
  renameSync(path.join(f.root, id(0)), deleting(f, 0));
  for (const child of ["a", "b"]) mkdirSync(path.join(deleting(f, 0), child));
  const moved = `${f.base}-moved`;
  roots.push(moved);
  let swapped = false;
  const failed: string[] = [];
  await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    removeRelease: async (directory) => {
      await removeReleaseTree(directory);
      if (swapped) return;
      swapped = true;
      renameSync(f.base, moved);
      symlinkSync(moved, f.base);
    },
    onError: (folder) => failed.push(path.basename(folder)),
  });
  expect(swapped).toBe(true);
  expect(failed).toEqual([id(0)]);
  // Two of the three children were never removed.
  const left = readdirSync(path.join(moved, "reviewed-updates", `.deleting-${id(0)}`));
  expect(left.filter((name) => ["a", "b", "build-x"].includes(name))).toHaveLength(2);
});

/** Every entry under `root` with its type, size, inode and modification time. */
function treeSnapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string) => {
    const info = lstatSync(directory);
    entries.push(`${path.relative(root, directory)} ${info.ino} ${info.mtimeMs} dir`);
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const child = lstatSync(full);
      if (child.isDirectory()) walk(full);
      else entries.push(`${path.relative(root, full)} ${child.ino} ${child.size} ${child.mtimeMs}`);
    }
  };
  walk(root);
  return entries;
}

test("a dry run changes nothing and lists exactly what a real run then removes", async () => {
  const f = fixture(6);
  // An earlier cleanup's leftovers: a copy beside its job folder, and an unfinished deletion.
  mkdirSync(path.join(f.root, `.pruning-${id(2)}-${"c".repeat(16)}`, "build-old"), {
    recursive: true,
  });
  mkdirSync(path.join(f.root, `.deleting-${id(9)}-${"d".repeat(16)}`));
  // A copy whose own name is free: the real run puts it back first. Its job started between
  // jobs 3 and 4, though its folder is the newest on disk, so job time decides it.
  mkdirSync(path.join(f.root, `.pruning-${id(7)}`, "build-x"), { recursive: true });
  const input = {
    releaseRoot: f.root,
    referenced: [f.current, { path: f.release(1), reason: "previous release (rollback)" }],
    keepNewest: 2,
    inUse: async () => [f.release(0)],
    startedAt: new Map([0, 1, 2, 3, 4, 5, 3.5].map((time, n) => [id(n === 6 ? 7 : n), time])),
  };
  const before = treeSnapshot(f.base);
  let dry: HostReleaseCleanupPlan | null = null;
  expect(
    await pruneHostReleases({ ...input, dryRun: true, onPlan: (plan) => (dry = plan) }),
  ).toEqual([]);
  expect(treeSnapshot(f.base)).toEqual(before);
  expect(dry).toEqual({
    remove: [id(7), id(3)],
    removeCopies: [`.pruning-${id(2)}-${"c".repeat(16)}`],
    finish: [`.deleting-${id(9)}-${"d".repeat(16)}`],
    kept: {
      [id(0)]: ["in use"],
      [id(1)]: ["previous release (rollback)"],
      [id(2)]: ["an earlier set-aside copy of it exists"],
      [id(4)]: ["one of the newest releases"],
      [id(5)]: ["one of the newest releases", "referenced"],
    },
  });
  let real: HostReleaseCleanupPlan | null = null;
  const removed = await pruneHostReleases({ ...input, onPlan: (plan) => (real = plan) });
  expect(real).toEqual(dry);
  // What it planned, plus the deletion an earlier cleanup started and this one finished.
  expect(removed.sort()).toEqual([...dry!.remove, id(9)].sort());
  expect(existsSync(f.release(3))).toBe(false);
  expect(existsSync(f.release(0))).toBe(true);
});

test("a real run records its plan before the first deletion", async () => {
  // After setting aside and putting back, before anything is removed: a cleanup that dies
  // while deleting has already said what it was removing and why.
  const f = fixture(5);
  mkdirSync(path.join(f.root, `.deleting-${id(9)}-${"e".repeat(16)}`, "build-x"), {
    recursive: true,
  });
  const events: string[] = [];
  await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    onPlan: (plan) => {
      events.push(`plan ${plan.remove.length}`);
      // Every folder it plans to remove is still there, set aside.
      for (const name of plan.remove)
        expect(existsSync(setAside(f, Number(name.slice(-1))))).toBe(true);
    },
    removeRelease: async (directory) => {
      events.push("delete");
      await removeReleaseTree(directory);
    },
  });
  expect(events[0]).toBe("plan 4");
  expect(events.filter((event) => event === "delete").length).toBeGreaterThan(0);
});
