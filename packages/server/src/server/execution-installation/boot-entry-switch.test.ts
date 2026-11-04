import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { BootEntrySwitchConfiguration } from "@getpaseo/protocol/execution-installation";
import {
  applyBootEntrySwitch,
  awaitBootEntryReadiness,
  bootEntryPointerBytes,
  bootEntrySwitchPlanDigest,
  bootEntrySwitchPreflight,
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

function plan(
  options: { rollback?: boolean; factory?: boolean } = {},
): BootEntrySwitchConfiguration {
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
    ...(options.factory === false
      ? {}
      : {
          factoryVerify: {
            script: hostFile("verify.sh", verifyBody, 0o755),
            sha256: sha(verifyBody),
            lockInode: 3901122,
            ownerMode: "paused" as const,
          },
        }),
  };
}

interface FakeDevOptions {
  /** The boot pointer's starting target. */
  pointsTo?: string;
  files?: Record<string, string>;
  /** Environment the restarted supervisor reports; defaults to the plain boot. */
  governedAfterRestart?: boolean;
  factory?: Record<string, unknown>[];
}

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
    const script = args[8]!;
    const params = args.slice(10);
    if (script.includes('sha256sum "$f"'))
      return {
        stdout: params
          .map((p) => `${p === POINTER ? sha(pointer) : (files[p] ?? "missing")} ${p}\n`)
          .join(""),
      };
    if (script === 'cat "$1"') return { stdout: pointer };
    if (script.includes('status "$2"')) return { stdout: `${pid}\n` };
    if (script.includes("base64 -d")) {
      effects.push(`install ${params[0]}`);
      files[params[0]!] = sha(Buffer.from(params[2]!, "base64").toString());
      return { stdout: "" };
    }
    if (script.includes("before-boot-switch")) {
      effects.push(`swap ${params[3]!.trim()}`);
      if (sha(pointer) !== params[1]) throw new Error("boot pointer changed before the swap");
      pointer = params[3]!;
      return { stdout: "" };
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

test("preflight refuses before any effect when Dev differs from the plan", async () => {
  const p = plan();
  const digest = bootEntrySwitchPlanDigest(p)!;
  const changed = fakeDev({ files: { [FACTORY_ENTRY]: sha("edited") }, factory: [launcherFacts] });
  await expect(bootEntrySwitchPreflight(p, digest, { run: changed.run })).rejects.toThrow(
    "the current boot entry differs from the plan. Nothing was changed.",
  );
  const already = fakeDev({ factory: [plainFacts] });
  await expect(bootEntrySwitchPreflight(p, digest, { run: already.run })).rejects.toThrow(
    "Dev already boots in the plain form",
  );
  expect([...changed.effects, ...already.effects]).toEqual([]);
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
  const p = plan({ factory: false });
  const dev = fakeDev({ governedAfterRestart: true });
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

test("rollback selects the retained Factory entry without copying anything", async () => {
  const p = plan({ rollback: true });
  const dev = fakeDev({
    pointsTo: PLAIN_ENTRY,
    files: { [PLAIN_ENTRY]: sha(plainBody) },
    governedAfterRestart: true,
    factory: [plainFacts, { ...launcherFacts, epoch: 55, supervisorPid: 123 }],
  });
  const preflight = await bootEntrySwitchPreflight(p, bootEntrySwitchPlanDigest(p)!, {
    run: dev.run,
  });
  await applyBootEntrySwitch(p, "job-3", { run: dev.run });
  await restartBootProgram(p, { run: dev.run });
  await awaitBootEntryReadiness(p, preflight, { run: dev.run, ...noWait });
  expect(await verifyFactoryAfterBootSwitch(p, preflight, { run: dev.run })).toContain(
    "accepted its lock again (epoch 55)",
  );
  expect(dev.effects).toEqual([`swap ${FACTORY_ENTRY}`, "restart paseo"]);
});
