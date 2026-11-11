import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
  // Dev's cached shared-folder inodes lead the VM's handle count and are judged on their own.
  const leading = fileTableCheck({ ...limits, vmOpenFiles: 10, fuseInodes: 900 });
  assert.equal(leading.status, "critical");
  assert.match(leading.summary, /Dev cached shared-folder inodes 900 of 1000 \(90%\)/);
  assert.equal(fileTableCheck({ ...limits, vmOpenFiles: null, fuseInodes: null }).detail.length, 1);
});

test("Dev's fuse_inode count comes from the active objects column of slabinfo", () => {
  const slabinfo = [
    "slabinfo - version: 2.1",
    "fuse_inode        732732 732748   1024   32    8 : tunables    0    0    0",
    "dentry            4123080 4123149    192   85    4 : tunables    0    0    0",
  ].join("\n");
  assert.equal(parseFuseInodes(slabinfo), 732732);
  assert.equal(parseFuseInodes("dentry 1 2 3"), null);
});

test("only work older than the window counts as stale", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const hours = (count) => now - count * 3_600_000;
  const check = staleWorktreeCheck(
    [
      { path: "/w/old-dirty", dirty: true, unpushed: 0, lastActivity: hours(30) },
      { path: "/w/old-unpushed", dirty: false, unpushed: 2, lastActivity: hours(48) },
      { path: "/w/fresh-dirty", dirty: true, unpushed: 0, lastActivity: hours(2) },
      { path: "/w/old-clean", dirty: false, unpushed: 0, lastActivity: hours(100) },
    ],
    { now, staleHours: 24 },
  );
  assert.equal(check.status, "warn");
  assert.deepEqual(
    check.detail.map((item) => item.path),
    ["/w/old-dirty", "/w/old-unpushed"],
  );
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
