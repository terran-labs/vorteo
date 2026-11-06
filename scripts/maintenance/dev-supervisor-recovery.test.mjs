import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RecoveryFailed,
  RecoveryRefused,
  containerHelper,
  decideRecovery,
  parseProgramStatus,
  preparePlan,
  recoverDevSupervisor,
  validateTargets,
} from "./dev-supervisor-recovery.mjs";

const ROOT = "/opt/vorteo-managed-releases";
const GOOD = `${ROOT}/good-job/release`;
const BAD = `${ROOT}/bad-job/release`;
const NODE = "/opt/node/bin/node";
const ENTRY = "packages/server/dist/server/server/daemon-worker.js";
const JOB = "11111111-2222-4333-8444-555555555555";

function targets() {
  return {
    version: 1,
    installationId: "installation",
    configurationFile: "/host/config.json",
    docker: "/usr/local/bin/docker",
    containerId: "8".repeat(64),
    serviceUser: "paseo",
    containerNode: NODE,
    paseoHome: "/home/paseo/.paseo",
    releaseRoot: ROOT,
    currentReleaseLink: `${ROOT}/current`,
    supervisorctl: "/usr/bin/supervisorctl",
    supervisordConfig: "/etc/personal-tailscale/supervisord.conf",
    program: "paseo",
    receiptFile: "/host/state/container-receipt.json",
    stateDirectory: "/host/state",
    evidenceDirectory: "/host/evidence",
  };
}

const receipt = { release: GOOD, sourceCommit: "a".repeat(40), sha256: "b".repeat(64) };
const goodRelease = {
  withinRoot: true,
  worker: true,
  source: { sourceCommit: receipt.sourceCommit, sha256: receipt.sha256 },
};
const failedActivation = { jobId: "bad-job", status: "activating", release: BAD, previous: GOOD };

test("targets must be prepared and name exactly the paseo program", () => {
  assert.throws(() => validateTargets(null), /unprepared/);
  assert.throws(() => validateTargets({ ...targets(), program: "tailscaled" }), /paseo program/);
  assert.throws(() => validateTargets({ ...targets(), containerId: "87348a2417ba" }), /full Dev/);
  assert.throws(
    () => validateTargets({ ...targets(), currentReleaseLink: "/tmp/current" }),
    /directly inside/,
  );
  assert.throws(() => validateTargets({ ...targets(), extra: true }), /exactly/);
  assert.deepEqual(validateTargets(targets()), targets());
});

test("supervisorctl status parses only the named program", () => {
  assert.deepEqual(
    parseProgramStatus(
      "tailscaled   RUNNING   pid 9, uptime 1:00:00\npaseo   FATAL     Exited too quickly (process log may have details)\n",
      "paseo",
    ),
    { state: "FATAL", detail: "Exited too quickly (process log may have details)" },
  );
  assert.throws(
    () => parseProgramStatus("unix:///var/run/supervisor.sock no such file", "paseo"),
    /exactly one paseo/,
  );
});

test("recovery selects only the receipted previous release after a failed activation", () => {
  const base = {
    selected: BAD,
    receipt,
    activations: [failedActivation],
    releases: { [GOOD]: goodRelease },
    workerStable: false,
  };
  const cases = [
    // Today's outage: the program is FATAL on the failed candidate.
    [{ program: { state: "FATAL" } }, { select: { from: BAD, to: GOOD }, start: true }],
    // The supervisor runs but the candidate's worker cannot start; the link is enough.
    [{ program: { state: "RUNNING" } }, { select: { from: BAD, to: GOOD }, start: false }],
    // Selection already restored by an earlier step; only the program needs starting.
    [
      { program: { state: "FATAL" }, selected: GOOD },
      { select: null, start: true },
    ],
    [{ program: { state: "RUNNING" }, workerStable: true }, /Nothing to recover/],
    [{ program: { state: "STOPPED" } }, /STOPPED/],
    [{ program: { state: "FATAL" }, selected: `${ROOT}/elsewhere` }, /not a failed activation/],
    [{ program: { state: "FATAL" }, activations: [] }, /not a failed activation/],
    [{ program: { state: "FATAL" }, selected: GOOD, activations: [] }, /without a recorded failed/],
    [
      { program: { state: "FATAL" }, releases: { [GOOD]: { ...goodRelease, worker: false } } },
      /differs from its protected receipt/,
    ],
    [
      {
        program: { state: "FATAL" },
        releases: {
          [GOOD]: { ...goodRelease, source: { ...goodRelease.source, sha256: "c".repeat(64) } },
        },
      },
      /differs from its protected receipt/,
    ],
  ];
  for (const [input, expected] of cases) {
    const run = () => decideRecovery({ ...base, ...input });
    if (expected instanceof RegExp) assert.throws(run, RecoveryRefused);
    if (expected instanceof RegExp) assert.throws(run, expected);
    else assert.deepEqual(run(), { ...expected, release: GOOD, failedJobs: ["bad-job"] });
  }
});

function fakeInstallation({ program = "FATAL", selected = BAD, evidence = {} } = {}) {
  const files = new Map([
    [
      "/host/config.json",
      JSON.stringify({
        public: { installationId: "installation" },
        stateDir: "/host/state",
        containerSourceUpdates: {
          docker: "/usr/local/bin/docker",
          containerId: "8".repeat(64),
          user: "paseo",
          node: NODE,
          home: "/home/paseo/.paseo",
          releaseRoot: ROOT,
          currentReleaseLink: `${ROOT}/current`,
          receiptFile: "/host/state/container-receipt.json",
        },
        container: { supervisorMaintenance: { node: "/n", script: "/s", sha256: "d".repeat(64) } },
      }),
    ],
    ["/host/state/container-receipt.json", JSON.stringify(receipt)],
    [
      "/host/state/container-source-updates/bad-job/activation.json",
      JSON.stringify({ ...failedActivation, jobId: undefined }),
    ],
    ...Object.entries(evidence),
  ]);
  const state = { program, selected, supervisorPid: null, clock: 0 };
  const commands = [];
  const observe = () => ({
    selected: state.selected,
    node: NODE,
    supervisor: state.supervisorPid
      ? { pid: state.supervisorPid, alive: true, ownsSelection: true }
      : null,
    workers: state.supervisorPid
      ? [{ pid: 700, ppid: state.supervisorPid, exe: NODE, release: state.selected }]
      : [],
  });
  const io = {
    uid: 501,
    now: () => state.clock,
    sleep: async (ms) => {
      state.clock += ms;
    },
    exists: (file) => files.has(file),
    readText(file) {
      assert.ok(files.has(file), file);
      return files.get(file);
    },
    listDirectory(directory) {
      const names = new Set();
      for (const file of files.keys())
        if (file.startsWith(`${directory}/`))
          names.add(file.slice(directory.length + 1).split("/")[0]);
      return [...names].sort();
    },
    stat: () => ({ isDirectory: true, uid: 501, mode: 0o40700 }),
    makePrivateDirectory(directory) {
      if ([...files.keys()].some((file) => file.startsWith(`${directory}/`)))
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      files.set(`${directory}/.created`, "");
    },
    writePrivateFile(file, value) {
      assert.ok(!files.has(file), `rewrote ${file}`);
      files.set(file, JSON.stringify(value));
    },
    async docker(args) {
      commands.push(args);
      if (args[0] === "inspect")
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              Id: "8".repeat(64),
              State: { Running: true, StartedAt: "t0", Health: { Status: "healthy" } },
            },
          ]),
          stderr: "",
        };
      assert.equal(args[0], "exec");
      if (args[4] === "/usr/bin/supervisorctl") {
        assert.deepEqual(args.slice(1, 4), ["--user", "root", "8".repeat(64)]);
        assert.deepEqual(args.slice(5, 7), ["-c", "/etc/personal-tailscale/supervisord.conf"]);
        assert.equal(args[8], "paseo");
        if (args[7] === "status")
          return {
            code: state.program === "RUNNING" ? 0 : 3,
            stdout: `paseo  ${state.program}  x\n`,
            stderr: "",
          };
        assert.equal(args[7], "start");
        state.program = "RUNNING";
        state.supervisorPid = 600;
        return { code: 0, stdout: "paseo: started\n", stderr: "" };
      }
      assert.deepEqual(args.slice(1, 4), ["--user", "paseo", "8".repeat(64)]);
      const input = JSON.parse(args.at(-1));
      if (input.action === "inspect")
        return {
          code: 0,
          stdout: JSON.stringify({ root: ROOT, ...observe(), releases: { [GOOD]: goodRelease } }),
          stderr: "",
        };
      if (input.action === "observe")
        return { code: 0, stdout: JSON.stringify(observe()), stderr: "" };
      assert.equal(input.action, "select");
      assert.deepEqual([input.from, input.to], [BAD, GOOD]);
      state.selected = GOOD;
      return { code: 0, stdout: JSON.stringify({ selected: GOOD }), stderr: "" };
    },
  };
  return { io, files, commands, state };
}

test("a FATAL Dev after a failed activation recovers once with rollback and evidence", async () => {
  const { io, files, commands, state } = fakeInstallation();
  const summary = await recoverDevSupervisor({
    targets: targets(),
    env: { VORTEO_RESTART_JOB_ID: JOB },
    io,
  });
  assert.match(summary, /previous retained release/);
  assert.equal(state.selected, GOOD);
  const supervisorctl = commands.filter((args) => args[4] === "/usr/bin/supervisorctl");
  assert.deepEqual(
    [...new Set(supervisorctl.map((args) => args.slice(7).join(" ")))],
    ["status paseo", "start paseo"],
  );
  assert.equal(supervisorctl.filter((args) => args[7] === "start").length, 1);
  const rollback = JSON.parse(files.get(`/host/evidence/${JOB}/rollback.json`));
  assert.deepEqual([rollback.from, rollback.to], [BAD, GOOD]);
  assert.equal(JSON.parse(files.get(`/host/evidence/${JOB}/result.json`)).status, "verified");

  // The same request never runs twice.
  await assert.rejects(
    recoverDevSupervisor({ targets: targets(), env: { VORTEO_RESTART_JOB_ID: JOB }, io }),
    /EEXIST/,
  );
});

test("refusals happen before effects and an unsettled attempt blocks new ones", async () => {
  const healthy = fakeInstallation({ program: "RUNNING", selected: GOOD });
  healthy.state.supervisorPid = 600;
  await assert.rejects(
    recoverDevSupervisor({
      targets: targets(),
      env: { VORTEO_RESTART_JOB_ID: JOB },
      io: healthy.io,
    }),
    /Nothing to recover/,
  );
  assert.ok(!healthy.commands.some((args) => args[7] === "start"));
  assert.equal(
    JSON.parse(healthy.files.get(`/host/evidence/${JOB}/result.json`)).status,
    "refused",
  );

  const interrupted = fakeInstallation({
    evidence: { [`/host/evidence/${"9".repeat(8)}-0000-4000-8000-000000000000/intent.json`]: "{}" },
  });
  await assert.rejects(
    recoverDevSupervisor({
      targets: targets(),
      env: { VORTEO_RESTART_JOB_ID: JOB },
      io: interrupted.io,
    }),
    /no recorded outcome/,
  );
  assert.deepEqual(interrupted.commands, []);

  const mismatched = fakeInstallation();
  await assert.rejects(
    recoverDevSupervisor({
      targets: { ...targets(), containerId: "7".repeat(64) },
      env: { VORTEO_RESTART_JOB_ID: JOB },
      io: mismatched.io,
    }),
    /source update targets differ/,
  );
  await assert.rejects(
    recoverDevSupervisor({ targets: targets(), env: {}, io: mismatched.io }),
    /approved tracked/,
  );
  assert.deepEqual(mismatched.commands, []);
});

test("a worker that never starts on the previous release fails without a second start", async () => {
  const { io, files, commands, state } = fakeInstallation();
  const docker = io.docker;
  io.docker = async (args) => {
    const result = await docker(args);
    if (args[7] === "start") state.supervisorPid = null;
    return result;
  };
  await assert.rejects(
    recoverDevSupervisor({ targets: targets(), env: { VORTEO_RESTART_JOB_ID: JOB }, io }),
    (error) => error instanceof RecoveryFailed && /not retried/.test(error.message),
  );
  assert.equal(commands.filter((args) => args[7] === "start").length, 1);
  const result = JSON.parse(files.get(`/host/evidence/${JOB}/result.json`));
  assert.deepEqual([result.status, result.phase], ["failed", "verify"]);
});

test("the container helper repoints the link atomically and observes the worker", () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-recovery-")));
  try {
    const root = path.join(temporary, "releases");
    const good = path.join(root, "good", "release");
    const bad = path.join(root, "bad", "release");
    for (const release of [good, bad]) {
      fs.mkdirSync(path.join(release, path.dirname(ENTRY)), { recursive: true });
      fs.writeFileSync(path.join(release, ENTRY), "");
    }
    const link = path.join(root, "current");
    fs.symlinkSync(bad, link);
    const home = path.join(temporary, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, "managed-supervisor.json"),
      JSON.stringify({ version: 1, link, root, pid: 600 }),
    );
    const proc = path.join(temporary, "proc");
    fs.mkdirSync(path.join(proc, "600"), { recursive: true });
    fs.writeFileSync(
      path.join(proc, "600", "environ"),
      `PASEO_MANAGED_RELEASE_LINK=${link}\0PASEO_MANAGED_RELEASE_ROOT=${root}\0`,
    );
    fs.mkdirSync(path.join(proc, "700"));
    fs.writeFileSync(path.join(proc, "700", "status"), "Name:\tnode\nPPid:\t600\n");
    fs.writeFileSync(path.join(proc, "700", "cmdline"), `node\0${good}/${ENTRY}\0`);
    fs.symlinkSync(process.execPath, path.join(proc, "700", "exe"));
    const input = {
      releaseRoot: root,
      currentReleaseLink: link,
      home,
      node: process.execPath,
      marker: "managed-supervisor.json",
      workerEntry: ENTRY,
      releaseSource: ".installation-source.json",
      jobId: JOB,
    };
    const deps = { files: fs, paths: path, procRoot: proc };
    assert.throws(
      () => containerHelper({ ...input, action: "select", from: good, to: good }, deps),
      /selection changed/,
    );
    assert.throws(
      () => containerHelper({ ...input, action: "select", from: bad, to: temporary }, deps),
      /escaped/,
    );
    assert.equal(fs.realpathSync(link), bad);
    containerHelper({ ...input, action: "select", from: bad, to: good }, deps);
    assert.equal(fs.realpathSync(link), good);
    const observed = containerHelper({ ...input, action: "observe" }, deps);
    assert.deepEqual(observed.supervisor, { pid: 600, alive: true, ownsSelection: true });
    assert.deepEqual(observed.workers, [
      { pid: 700, ppid: 600, exe: fs.realpathSync(process.execPath), release: good },
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a prepared copy binds its targets and refuses outside a tracked request", () => {
  const script = fileURLToPath(new URL("./dev-supervisor-recovery.mjs", import.meta.url));
  const source = fs.readFileSync(script, "utf8");
  const { prepared, value } = preparePlan({
    source,
    targets: targets(),
    node: process.execPath,
    output: "/protected/dev-supervisor-recovery.mjs",
  });
  assert.equal(value.sha256, createHash("sha256").update(prepared).digest("hex"));
  assert.ok(prepared.includes(JSON.stringify(targets())));
  // The coordinator evaluates the bytes with no script path.
  const evaluated = spawnSync(process.execPath, ["--input-type=module", "--eval", prepared], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(evaluated.status, 1);
  assert.match(evaluated.stderr, /approved tracked supervisor maintenance request/);
  const unprepared = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    env: { PATH: process.env.PATH, VORTEO_RESTART_JOB_ID: JOB },
    encoding: "utf8",
  });
  assert.equal(unprepared.status, 1);
  assert.match(unprepared.stderr, /unprepared/);
});
