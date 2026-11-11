import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { BootEntrySwitchConfiguration } from "@getpaseo/protocol/execution-installation";
import {
  applyBootEntrySwitch,
  awaitBootEntryReadiness,
  bootEntryPointerBytes,
  bootEntrySwitchPinProblem,
  RETIRED_LAUNCHER,
  bootEntrySwitchPlanDigest,
  bootEntrySwitchPreflight,
  INSTALL_TARGET,
  SWAP_POINTER,
  TARGET_DIRECTORY_CHECK,
  restartBootProgram,
  verifyFactoryAfterBootSwitch,
} from "./boot-entry-switch.js";
import type { EngineCommand } from "./factory-verify.js";

const DEV = "d".repeat(64);
const POINTER = "/etc/paseo-server-entry";
const FACTORY_ENTRY = "/opt/vorteo-managed-releases/bootstrap/factory-main-entry.mjs";
const PLAIN_ENTRY = "/opt/vorteo-boot/plain-supervisor-entry.mjs";
const NODE = "/tmp/node-v22/bin/node";
const SUPERVISOR = "/opt/vorteo-managed-releases/r/supervisor-entrypoint.js";
const roots: string[] = [];
const execFileAsync = promisify(execFile);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hostFile(name: string, body: string, mode = 0o644) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "boot-entry-switch-")));
  roots.push(root);
  const file = path.join(root, name);
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

const plainBody = "// plain entry\n";
const factoryBody = "// factory entry\n";

function plan(options: { rollback?: boolean } = {}): BootEntrySwitchConfiguration {
  const forward = !options.rollback;
  const verifyBody = "#!/bin/sh\nexit 0\n";
  return {
    docker: process.execPath,
    socket: "/fixture/docker.sock",
    container: DEV,
    current: {
      pointer: {
        path: POINTER,
        sha256: sha(bootEntryPointerBytes(forward ? FACTORY_ENTRY : PLAIN_ENTRY)),
      },
      entry: forward
        ? { path: FACTORY_ENTRY, sha256: sha(factoryBody) }
        : { path: PLAIN_ENTRY, sha256: sha(plainBody) },
    },
    target: forward
      ? { path: PLAIN_ENTRY, sha256: sha(plainBody), source: hostFile("plain.mjs", plainBody) }
      : { path: FACTORY_ENTRY, sha256: sha(factoryBody) },
    node: { path: NODE, sha256: sha("node") },
    supervisorEntry: { path: SUPERVISOR, sha256: sha("supervisor") },
    supervisor: { config: "/etc/personal-tailscale/supervisord.conf", program: "paseo" },
    expectBootForm: forward ? "plain" : "launcher",
    deadlineSeconds: 60,
    factoryVerify: {
      script: hostFile("verify.sh", verifyBody, 0o755),
      sha256: sha(verifyBody),
      lockInode: 3901122,
      ownerMode: "paused" as const,
    },
  };
}

interface FakeDevOptions {
  /** The boot pointer's starting target. */
  pointsTo?: string;
  files?: Record<string, string>;
  /** Environment the restarted supervisor reports; defaults to the plain boot. */
  governedAfterRestart?: boolean;
  factory?: Record<string, unknown>[];
  /** What the directory check reports for the pointer and target directories. */
  directory?: string;
  /** Files no Dev user can read. */
  unreadable?: string[];
}

/**
 * Like live Dev, which drops every capability: its root cannot read the paseo-private
 * Factory entry (0600) or anything under the managed releases (0700). The pointer, node and
 * installed plain entry are world-readable.
 */
const PASEO_PRIVATE = new Set([FACTORY_ENTRY, SUPERVISOR]);

/** A fake Dev behind `docker exec`: pointer, file digests, supervisord and Factory's check. */
function fakeDev(options: FakeDevOptions = {}) {
  const effects: string[] = [];
  let pointer = bootEntryPointerBytes(options.pointsTo ?? FACTORY_ENTRY);
  const files: Record<string, string> = {
    [FACTORY_ENTRY]: sha(factoryBody),
    [NODE]: sha("node"),
    [SUPERVISOR]: sha("supervisor"),
    ...options.files,
  };
  let pid = 23;
  const factory = [...(options.factory ?? [])];
  const run: EngineCommand = async (file, args) => {
    if (args[0] === "--docker") {
      const facts = factory.shift() ?? { ok: false, check: "unexpected" };
      if (!facts.ok)
        throw Object.assign(new Error("exit 1"), { stdout: `${JSON.stringify(facts)}\n` });
      return { stdout: `${JSON.stringify(facts)}\n` };
    }
    if (args[2] === "inspect") {
      const state = {
        Running: true,
        StartedAt: "2026-11-04T05:14:21Z",
        Health: { Status: "healthy" },
      };
      return { stdout: `${DEV}|${JSON.stringify(state)}\n` };
    }
    expect(args.slice(2, 4)).toEqual(["exec", "--user"]);
    const user = args[4]!;
    const script = args[8]!;
    const params = args.slice(10);
    if (script.includes('sha256sum "$f"'))
      return {
        stdout: params
          .map((p) => {
            const blocked =
              options.unreadable?.includes(p) || (user === "0" && PASEO_PRIVATE.has(p));
            const digest = p === POINTER ? sha(pointer) : (files[p] ?? "missing");
            return `${blocked ? "unreadable" : digest} ${p}\n`;
          })
          .join(""),
      };
    if (script === 'cat "$1"') return { stdout: pointer };
    if (script.includes('status "$2"')) return { stdout: `${pid}\n` };
    if (script.includes("base64 -d")) {
      // The coordinator always installs as root.
      expect(params.slice(3)).toEqual(["0", "0"]);
      effects.push(`install ${params[0]}`);
      files[params[0]!] = sha(Buffer.from(params[2]!, "base64").toString());
      return { stdout: "" };
    }
    if (script.includes("before-boot-switch")) {
      expect(params.slice(5)).toEqual(["0", "0"]);
      effects.push(`swap ${params[3]!.trim()}`);
      if (sha(pointer) !== params[1]) throw new Error("boot pointer changed before the swap");
      pointer = params[3]!;
      return { stdout: "" };
    }
    if (script.includes("echo safe")) {
      expect(params[1]).toBe("0");
      return { stdout: `${options.directory ?? "safe"}\n` };
    }
    if (script.includes('restart "$2"')) {
      effects.push("restart paseo");
      pid += 100;
      return { stdout: "" };
    }
    if (script.includes("/proc/$1/cmdline")) {
      const env = [
        "PASEO_MANAGED_RELEASE_ROOT=/opt/vorteo-managed-releases",
        "PASEO_MANAGED_RELEASE_LINK=/opt/vorteo-managed-releases/current",
        ...(options.governedAfterRestart ? ["PASEO_GOVERNED_RUNTIME_MODULE=/tmp/runtime.mjs"] : []),
      ];
      return { stdout: `${NODE}\n${SUPERVISOR}\n--environ--\n${env.join("\n")}\n` };
    }
    throw new Error(`unexpected command ${file} ${args.join(" ")}`);
  };
  return { run, effects, pointer: () => pointer };
}

const launcherFacts = {
  ok: true,
  check: "all",
  epoch: 54,
  supervisorPid: 23,
  ownerMode: "paused",
  ownerSequence: 14,
  custodyCount: 454,
  custodyDigest: "e".repeat(64),
  bootForm: "launcher",
};
const plainFacts = { ...launcherFacts, bootForm: "plain" };
const noWait = { sleep: async () => {} };

test("the plan digest is withheld when its Host-side inputs are unsafe", () => {
  const good = plan();
  expect(bootEntrySwitchPlanDigest(good)).toMatch(/^[a-f0-9]{64}$/);
  expect(
    bootEntrySwitchPlanDigest({ ...good, target: { ...good.target, sha256: sha("other") } }),
  ).toBeUndefined();
  expect(
    bootEntrySwitchPlanDigest({ ...good, target: { ...good.target, path: FACTORY_ENTRY } }),
  ).toBeUndefined();
  const writable = plan();
  chmodSync(writable.target.source!, 0o666);
  expect(bootEntrySwitchPlanDigest(writable)).toBeUndefined();
});

test.each([
  [
    "a changed current entry",
    { files: { [FACTORY_ENTRY]: sha("edited") } },
    "the current boot entry differs",
  ],
  [
    "a pointer naming another entry",
    { pointsTo: "/opt/other.mjs" },
    "the boot pointer does not name the expected current entry",
  ],
  ["a different node", { files: { [NODE]: sha("other node") } }, "the node runtime differs"],
  [
    "a different supervisor entry",
    { files: { [SUPERVISOR]: sha("other") } },
    "the supervisor entry differs",
  ],
  [
    "a directory another user controls",
    { directory: "/opt/vorteo-boot is owned by uid 1000" },
    "the boot pointer directory is unsafe (/opt/vorteo-boot is owned by uid 1000)",
  ],
  [
    "a pinned file paseo cannot read",
    { unreadable: [NODE] },
    "the node runtime is not readable by paseo",
  ],
  [
    "Dev already in the plain form",
    { factory: [plainFacts] },
    "Dev already boots in the plain form",
  ],
] as const)("preflight refuses %s before any effect", async (_name, options, message) => {
  const p = plan();
  const dev = fakeDev({ factory: [launcherFacts], ...options });
  await expect(
    bootEntrySwitchPreflight(p, bootEntrySwitchPlanDigest(p)!, { run: dev.run }),
  ).rejects.toThrow(`${message}`);
  expect(dev.effects).toEqual([]);
});

test("the switch waits until every coordinator Factory gate pins its own check", () => {
  const p = plan();
  const own = p.factoryVerify.sha256;
  expect(bootEntrySwitchPinProblem(p, { factoryGate: own, engineRestart: own })).toBeNull();
  expect(bootEntrySwitchPinProblem(p, {})).toBeNull();
  expect(bootEntrySwitchPinProblem(p, { factoryGate: own, engineRestart: "3".repeat(64) })).toBe(
    "engineRestart must pin the same Factory check as the switch before it runs",
  );
});

test("the switch installs the target, swaps the pointer, restarts and verifies the plain boot", async () => {
  const p = plan();
  const dev = fakeDev({ factory: [launcherFacts, plainFacts] });
  const preflight = await bootEntrySwitchPreflight(p, bootEntrySwitchPlanDigest(p)!, {
    run: dev.run,
  });
  const backup = await applyBootEntrySwitch(p, "job-1", { run: dev.run });
  await restartBootProgram(p, { run: dev.run });
  const checks = await awaitBootEntryReadiness(p, preflight, { run: dev.run, ...noWait });
  const factory = await verifyFactoryAfterBootSwitch(p, preflight, { run: dev.run });
  expect(dev.effects).toEqual([`install ${PLAIN_ENTRY}`, `swap ${PLAIN_ENTRY}`, "restart paseo"]);
  expect(dev.pointer()).toBe(bootEntryPointerBytes(PLAIN_ENTRY));
  expect(backup).toBe(`${POINTER}.before-boot-switch-job-1`);
  expect(checks).toContain("supervisor environment has no Factory runtime");
  expect(factory).toContain("boots without its launcher");
});

test("readiness fails when the restarted supervisor still loads Factory's runtime", async () => {
  const p = plan();
  const dev = fakeDev({ governedAfterRestart: true, factory: [launcherFacts] });
  const preflight = await bootEntrySwitchPreflight(p, bootEntrySwitchPlanDigest(p)!, {
    run: dev.run,
  });
  await applyBootEntrySwitch(p, "job-2", { run: dev.run });
  await restartBootProgram(p, { run: dev.run });
  let clock = 0;
  await expect(
    awaitBootEntryReadiness(p, preflight, {
      run: dev.run,
      sleep: async () => {},
      now: () => (clock += 30_000),
    }),
  ).rejects.toThrow("the new supervisor runs without Factory's runtime was not met");
});

test("Factory verification refuses changed custody after the switch", async () => {
  const p = plan();
  const dev = fakeDev({
    factory: [launcherFacts, { ...plainFacts, custodyDigest: "f".repeat(64) }],
  });
  const preflight = await bootEntrySwitchPreflight(p, bootEntrySwitchPlanDigest(p)!, {
    run: dev.run,
  });
  await expect(verifyFactoryAfterBootSwitch(p, preflight, { run: dev.run })).rejects.toThrow(
    "Factory's custody records changed while paused",
  );
});

test("a switch back to the retired Factory launcher is refused before any effect", async () => {
  const p = plan({ rollback: true });
  expect(bootEntrySwitchPinProblem(p, {})).toBe(RETIRED_LAUNCHER);
  const dev = fakeDev({
    pointsTo: PLAIN_ENTRY,
    files: { [PLAIN_ENTRY]: sha(plainBody) },
    factory: [plainFacts],
  });
  await expect(
    bootEntrySwitchPreflight(p, bootEntrySwitchPlanDigest(p)!, { run: dev.run }),
  ).rejects.toThrow(RETIRED_LAUNCHER);
  expect(dev.effects).toEqual([]);
});

/** Runs one of the real effect scripts under /bin/sh with the test user as the owner. */
async function sh(script: string, args: string[]) {
  const ids = [String(process.getuid!()), String(process.getgid!())];
  return execFileAsync("/bin/sh", ["-c", script, "sh", ...args, ...ids]).then(
    ({ stdout }) => ({ ok: true, out: stdout }),
    (error: { stderr?: string }) => ({ ok: false, out: error.stderr ?? "" }),
  );
}

test("the real install and swap scripts replace files atomically and refuse unsafe states", async () => {
  // On Linux this is under the sticky /tmp, which the ancestor check accepts.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "boot-entry-scripts-")));
  roots.push(root);
  const target = path.join(root, "boot", "plain.mjs");
  const install = (file: string) =>
    sh(INSTALL_TARGET, [file, sha(plainBody), Buffer.from(plainBody).toString("base64")]);
  // The target directory is created owner-only-writable and the entry lands whole.
  expect(await install(target)).toEqual({ ok: true, out: "" });
  expect(readFileSync(target, "utf8")).toBe(plainBody);
  expect(statSync(target).mode & 0o777).toBe(0o644);
  expect(readdirSync(path.dirname(target))).toEqual(["plain.mjs"]);
  // A symlinked or group-writable directory is refused before anything is written.
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(root, "linked"));
  expect((await install(path.join(root, "linked", "plain.mjs"))).out).toContain("is a symlink");
  expect(readdirSync(elsewhere)).toEqual([]);
  const shared = path.join(root, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o775);
  expect((await install(path.join(shared, "plain.mjs"))).out).toContain("writable by group");
  expect((await sh(TARGET_DIRECTORY_CHECK, [path.join(shared, "x")])).out).toContain(
    "writable by group or others",
  );

  const pointer = path.join(root, "boot", "paseo-server-entry");
  writeFileSync(pointer, bootEntryPointerBytes(FACTORY_ENTRY));
  const next = bootEntryPointerBytes(target);
  const swap = (current: string, suffix: string) =>
    sh(SWAP_POINTER, [pointer, current, suffix, next, sha(next)]);
  // A pointer that changed since preflight is left alone.
  expect((await swap(sha("other"), "job-a")).out).toContain("boot pointer changed before the swap");
  expect(readFileSync(pointer, "utf8")).toBe(bootEntryPointerBytes(FACTORY_ENTRY));
  // The swap keeps the old bytes as the job's backup and leaves no temporary file.
  const current = sha(bootEntryPointerBytes(FACTORY_ENTRY));
  expect(await swap(current, "job-b")).toEqual({ ok: true, out: "" });
  expect(readFileSync(pointer, "utf8")).toBe(next);
  expect(readFileSync(`${pointer}.before-boot-switch-job-b`, "utf8")).toBe(
    bootEntryPointerBytes(FACTORY_ENTRY),
  );
  expect(readdirSync(path.dirname(pointer)).sort()).toEqual([
    "paseo-server-entry",
    "paseo-server-entry.before-boot-switch-job-b",
    "plain.mjs",
  ]);
  // An existing backup name is never overwritten.
  writeFileSync(pointer, bootEntryPointerBytes(FACTORY_ENTRY));
  expect((await swap(current, "job-b")).out).toContain("backup already exists");
});
