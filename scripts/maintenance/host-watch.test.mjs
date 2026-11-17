import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import {
  parseDevWorktrees,
  collectWorktrees,
  devWorktrees,
  worktreeSeconds,
  countDescriptors,
  backupCoverageCheck,
  fileTableCheck,
  parseFuseInodes,
  staleWorktreeCheck,
} from "./host-watch.mjs";

test("file-table pressure warns at 70% and turns critical at 85% of each limit", () => {
  const limits = { maxFiles: 1000, maxFilesPerProc: 500, openFiles: 100 };
  assert.equal(fileTableCheck({ ...limits, vmOpenFiles: 340, fuseInodes: null }).status, "ok");
  assert.equal(fileTableCheck({ ...limits, vmOpenFiles: 350, fuseInodes: null }).status, "warn");
  assert.equal(
    fileTableCheck({ ...limits, vmOpenFiles: 425, fuseInodes: null }).status,
    "critical",
  );
  // Dev's cached shared-folder inodes lead the VM's handles: judged on the per-process limit.
  const leading = fileTableCheck({ ...limits, vmOpenFiles: 10, fuseInodes: 450 });
  assert.equal(leading.status, "critical");
  assert.match(leading.summary, /Dev cached shared-folder inodes 450 of 500 \(90%\)/);
  // Not requested is left out; requested but unreadable reports unknown.
  assert.equal(fileTableCheck({ ...limits, vmOpenFiles: null, fuseInodes: null }).detail.length, 1);
  const unread = fileTableCheck({ ...limits, vmOpenFiles: NaN, fuseInodes: NaN });
  assert.equal(unread.status, "unknown");
  assert.match(unread.summary, /Docker VM unknown; Dev cached shared-folder inodes unknown/);
  assert.equal(
    fileTableCheck({ ...limits, maxFiles: 0, vmOpenFiles: null, fuseInodes: null }).status,
    "unknown",
  );
});

test("open files count numbered and truncated descriptors, not cwd or txt", () => {
  assert.equal(
    countDescriptors(["p78655", "fcwd", "ftxt", "f0", "f17", "f*264", "f*122"].join("\n")),
    4,
  );
});

test("Dev's fuse_inode count comes from the active objects column of slabinfo", () => {
  const slabinfo = [
    "slabinfo - version: 2.1",
    "fuse_inode        732732 732748   1024   32    8 : tunables    0    0    0",
    "dentry            4123080 4123149    192   85    4 : tunables    0    0    0",
  ].join("\n");
  assert.equal(parseFuseInodes(slabinfo), 732732);
  assert.ok(Number.isNaN(parseFuseInodes("dentry 1 2 3")));
});

test("only work older than the window counts as stale, and an unfinished pass is not ok", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const hours = (count) => now - count * 3_600_000;
  const check = staleWorktreeCheck(
    {
      worktrees: [
        { path: "/w/old-dirty", dirty: true, unpushed: 0, lastActivity: hours(30) },
        { path: "/w/old-unpushed", dirty: false, unpushed: 2, lastActivity: hours(48) },
        {
          path: "/w/old-local",
          dirty: false,
          unpushed: 0,
          noRemote: true,
          lastActivity: hours(48),
        },
        { path: "/w/fresh-dirty", dirty: true, unpushed: 0, lastActivity: hours(2) },
        { path: "/w/old-clean", dirty: false, unpushed: 0, lastActivity: hours(100) },
      ],
    },
    { now, staleHours: 24 },
  );
  assert.equal(check.status, "warn");
  assert.deepEqual(check.detail, [
    { path: "/w/old-dirty", dirty: true, unpushed: 0 },
    { path: "/w/old-unpushed", dirty: false, unpushed: 2 },
    { path: "/w/old-local", dirty: false, noRemote: true },
  ]);
  const partial = staleWorktreeCheck({ worktrees: [], skipped: 3 }, { now, staleHours: 24 });
  assert.equal(partial.status, "unknown");
  assert.match(partial.summary, /3 worktree or repository probes unreadable or skipped/);
});

test("backup coverage names each precious path the latest completed backup lacks", () => {
  const contains = (latest, item) => item !== "/new/secured";
  const missing = backupCoverageCheck(
    { latest: "/Volumes/.timemachine/x/2026-11-09-040335.backup", contains },
    ["/state", "/new/secured"],
  );
  assert.equal(missing.status, "warn");
  assert.deepEqual(missing.detail, ["/new/secured"]);
  assert.equal(
    backupCoverageCheck({ latest: "/b", contains: () => true }, ["/state"]).status,
    "ok",
  );
  assert.equal(backupCoverageCheck({ latest: null, contains }, ["/state"]).status, "warn");
});

test("Dev output accounts for every requested path, including omitted and malformed rows", () => {
  const good = {
    path: "/a",
    status: "ok",
    dirty: null,
    noRemote: false,
    unpushed: 0,
    lastActivity: 1000,
  };
  const output = [
    good,
    { ...good, path: "/b", status: "unknown" },
    { ...good, path: "/c", unpushed: "?" },
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.deepEqual(parseDevWorktrees(output, ["/a", "/b", "/c", "/missing"]), {
    worktrees: [{ path: "/a", dirty: null, noRemote: false, unpushed: 0, lastActivity: 1000 }],
    skipped: 3,
    unreadable: ["/b", "/c", "/missing"],
  });
});

// In-memory executor adapters make budget exhaustion deterministic without live probes.
function worktreeFixture({ fail = "", advance = () => {} } = {}) {
  const calls = [];
  const filesystem = {
    readdirSync: () => ["repo", "later-repo"],
    existsSync: () => true,
    statSync: (name) => {
      if (fail === "directory" && name === "/linked") throw new Error("missing");
      return { isDirectory: () => true, mtimeMs: 1000 };
    },
  };
  const execute = (_command, args, options) => {
    const operation = args[4];
    calls.push({ args, options });
    advance(operation);
    if (operation === fail) throw new Error("probe failed");
    if (operation === "rev-parse") {
      if (fail === "rev-parse") throw new Error("unreadable");
      return args[5] === "--git-common-dir" ? "/common" : "/gitdir";
    }
    if (operation === "worktree") return "worktree /main\0\0worktree /linked\0\0";
    if (operation === "remote") return "origin";
    if (operation === "rev-list") return "0";
    if (operation === "status") return "";
    throw new Error(`Unexpected probe ${operation}`);
  };
  return { filesystem, execute, calls };
}

test("routine Host worktree checks do not scan files; opt-in status failures stay unknown", () => {
  const fixture = worktreeFixture();
  const result = collectWorktrees(["/projects"], 100, null, { ...fixture, now: () => 0 });
  assert.deepEqual(result.worktrees, [
    { path: "/linked", dirty: null, noRemote: false, unpushed: 0, lastActivity: 1000 },
  ]);
  assert.equal(result.skipped, 0);
  assert.equal(
    fixture.calls.some(({ args }) => args.includes("status")),
    false,
  );
  const summary = staleWorktreeCheck(result, { now: 2000, staleHours: 24 });
  assert.equal(summary.fileChangesChecked, false);
  assert.doesNotMatch(summary.summary, /uncommitted/);
  const failure = worktreeFixture({ fail: "status" });
  const unreadable = collectWorktrees(["/projects"], 100, null, {
    ...failure,
    inspectFiles: true,
    now: () => 0,
  });
  assert.deepEqual(unreadable.unreadable, ["/linked"]);
  assert.equal(staleWorktreeCheck(unreadable, { now: 2000, staleHours: 24 }).status, "unknown");
});

test("worktree deadline includes discovery and shrinks each command timeout", () => {
  for (const invalid of ["NaN", "Infinity", "0", "-1", "301"]) {
    assert.throws(() => worktreeSeconds(invalid), /between 1 and 300/);
  }
  assert.equal(worktreeSeconds("120"), 120);
  let clock = 0;
  const fixture = worktreeFixture({
    advance: () => {
      clock += 30;
    },
  });
  const result = collectWorktrees(["/projects", "/never-discovered"], 50, null, {
    ...fixture,
    now: () => clock,
  });
  assert.deepEqual(
    fixture.calls.map(({ options }) => options.timeout),
    [50, 20],
  );
  assert.equal(result.skipped, 3);
  assert.deepEqual(result.worktrees, []);
  let probeClock = 0;
  const duringWorktree = worktreeFixture({
    advance: (operation) => {
      if (operation === "remote") probeClock = 50;
    },
  });
  const interrupted = collectWorktrees(["/projects"], 50, null, {
    ...duringWorktree,
    now: () => probeClock,
  });
  assert.deepEqual(interrupted.unreadable, ["/linked", "/projects/later-repo"]);
  assert.equal(
    duringWorktree.calls.some(({ args }) => args.includes("rev-list")),
    false,
  );
  const expired = collectWorktrees(["/projects"], 50, null, {
    now: () => 50,
    filesystem: { readdirSync: () => assert.fail("discovery after deadline") },
    execute: () => assert.fail("command after deadline"),
  });
  assert.deepEqual(expired.unreadable, ["/projects"]);
});

test("Dev executor emits unknown for missing paths and every failed Git probe", () => {
  // Execute the actual generated Dev program, substituting only OS operations.
  for (const fail of ["directory", "rev-parse", "remote", "rev-list", "status", ""]) {
    const fixture = worktreeFixture({ fail });
    const inspectFiles = fail === "status";
    let emitted;
    const result = devWorktrees({ docker: "docker", container: "dev" }, ["/linked"], 100, {
      now: () => 0,
      inspectFiles,
      execute: (command, args, options) => {
        assert.equal(command, "docker");
        assert.equal(options.timeout, 100);
        assert.deepEqual(args.slice(-4, -1), ["0.1", "node", "-e"]);
        let output = "";
        vm.runInNewContext(args.at(-1), {
          require: (name) => {
            if (name === "node:fs")
              return { ...fixture.filesystem, readFileSync: () => options.input };
            if (name === "node:child_process") return { execFileSync: fixture.execute };
            assert.fail(`Unexpected module ${name}`);
          },
          Date: { now: () => 0 },
          process: {
            env: {},
            stdout: {
              write: (text) => {
                output += text;
              },
            },
          },
        });
        emitted = JSON.parse(output);
        return output;
      },
    });
    assert.equal(emitted.path, "/linked");
    assert.equal(emitted.status, fail ? "unknown" : "ok");
    assert.equal(result.skipped, fail ? 1 : 0);
    assert.equal(result.worktrees.length, fail ? 0 : 1);
    assert.equal(
      fixture.calls.every(({ options }) => options.timeout > 0 && options.timeout <= 100),
      true,
    );
    assert.equal(
      fixture.calls.some(({ args }) => args.includes("status")),
      inspectFiles,
    );
  }
  const expired = devWorktrees({ docker: "docker", container: "dev" }, ["/linked"], 100, {
    now: () => 100,
    execute: () => assert.fail("Dev launched after deadline"),
  });
  assert.deepEqual(expired, { worktrees: [], skipped: 1, unreadable: ["/linked"] });
});
