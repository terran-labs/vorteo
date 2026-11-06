import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  hostLauncherPlanDigest,
  runHostLauncherUpdate,
  verifyLauncherCandidate,
  type HostLauncherTarget,
} from "./host-launcher-update.js";
import type { EngineCommand } from "./factory-verify.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const live = {
  Label: "local.vorteo.fixture.host",
  ProgramArguments: [
    "/node",
    "/install/current/packages/server/dist/scripts/supervisor-entrypoint.js",
  ],
  EnvironmentVariables: { HOME: "/Users/fixture", PATH: "/usr/bin" },
  KeepAlive: true,
};

/** Plists are stored as JSON in tests; production parses real plists with plutil. */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "host-launcher-")));
  roots.push(root);
  const releases = path.join(root, "releases");
  const release = path.join(releases, "r1");
  mkdirSync(path.join(release, "packages/server"), { recursive: true });
  writeFileSync(
    path.join(release, "packages/server/package.json"),
    JSON.stringify({ version: "0.11.0-beta.3.vorteo.810" }),
  );
  const link = path.join(root, "current");
  symlinkSync(release, link);
  const plist = path.join(root, "host.plist");
  const liveBytes = JSON.stringify(live);
  writeFileSync(plist, liveBytes, { mode: 0o600 });
  const candidate = path.join(root, "candidate.plist");
  const candidateBytes = JSON.stringify({
    ...live,
    EnvironmentVariables: {
      ...live.EnvironmentVariables,
      PASEO_MANAGED_RELEASE_LINK: link,
      PASEO_MANAGED_RELEASE_ROOT: releases,
    },
  });
  writeFileSync(candidate, candidateBytes, { mode: 0o600 });
  const state = path.join(root, "state");
  mkdirSync(state);
  const target: HostLauncherTarget = {
    domain: "gui/501",
    label: live.Label,
    plist,
    candidate: {
      path: candidate,
      sha256: createHash("sha256").update(candidateBytes).digest("hex"),
    },
    link,
    root: releases,
    stateDir: state,
  };
  const plistJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  return { root, target, plistJson, liveBytes, candidateBytes, link, releases };
}

/** Fake launchd: bootstrap starts a new supervisor; ps reports the plist environment it loaded. */
function fakeLaunchd(target: HostLauncherTarget, options: { bootstrapFails?: boolean } = {}) {
  const calls: string[] = [];
  let supervisor = 100;
  let loaded = JSON.parse(readFileSync(target.plist, "utf8"));
  const run: EngineCommand = async (file, args) => {
    calls.push([path.basename(file), ...args.slice(0, 1)].join(" "));
    if (args[0] === "print") return { stdout: `\tstate = running\n\tpid = ${supervisor}\n` };
    if (args[0] === "bootout") return { stdout: "" };
    if (args[0] === "bootstrap") {
      if (options.bootstrapFails) throw new Error("bootstrap failed");
      loaded = JSON.parse(readFileSync(target.plist, "utf8"));
      supervisor += 1;
      return { stdout: "" };
    }
    if (path.basename(file) === "ps") {
      const environment = Object.entries(loaded.EnvironmentVariables as Record<string, string>)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      return { stdout: `node supervisor-entrypoint.js ${environment}\n` };
    }
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  };
  return { run, calls };
}

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

test("the candidate may add only the managed release link and root", () => {
  const f = fixture();
  const env = { ...live.EnvironmentVariables };
  const exact = {
    ...live,
    EnvironmentVariables: {
      ...env,
      PASEO_MANAGED_RELEASE_LINK: f.link,
      PASEO_MANAGED_RELEASE_ROOT: f.releases,
    },
  };
  expect(() => verifyLauncherCandidate(live, exact, f.link, f.releases)).not.toThrow();
  expect(() =>
    verifyLauncherCandidate(live, { ...exact, KeepAlive: false }, f.link, f.releases),
  ).toThrow("changes more than");
  expect(() => verifyLauncherCandidate(live, exact, "/elsewhere", f.releases)).toThrow(
    "changes more than",
  );
  expect(() => verifyLauncherCandidate(exact, exact, f.link, f.releases)).toThrow(
    "already selects managed releases",
  );
});

test("the plan digest binds the candidate and the live launcher", () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(f.target.plist, JSON.stringify({ ...live, KeepAlive: false }));
  expect(hostLauncherPlanDigest(f.target, f.plistJson)).toBeUndefined();
  writeFileSync(f.target.plist, f.liveBytes);
  expect(hostLauncherPlanDigest(f.target, f.plistJson)).toBe(digest);
  expect(
    hostLauncherPlanDigest(
      { ...f.target, candidate: { ...f.target.candidate, sha256: "0".repeat(64) } },
      f.plistJson,
    ),
  ).toBeUndefined();
  expect(hostLauncherPlanDigest(undefined)).toBeUndefined();
});

test("the update swaps the launcher, reloads it once and verifies the new Host", async () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target);
  let pid = 10;
  const detail = await runHostLauncherUpdate(
    f.target,
    { jobId: "job", digest },
    {
      run: launchd.run,
      plistJson: f.plistJson,
      probe: async () => ({ pid: pid++, version: "0.11.0-beta.3.vorteo.810" }),
      ...clock(),
    },
  );
  expect(detail).toContain("Host launcher updated");
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.candidateBytes);
  expect(
    readFileSync(path.join(f.target.stateDir, "host-launcher-fallback-job.plist"), "utf8"),
  ).toBe(f.liveBytes);
  expect(launchd.calls.filter((call) => call === "launchctl bootstrap")).toHaveLength(1);
});

test("a Host that comes back on another build restores the previous launcher", async () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target);
  let pid = 10;
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest },
      {
        run: launchd.run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: pid++, version: "0.11.0-beta.3.vorteo.809" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow(
    "The Host restarted on 0.11.0-beta.3.vorteo.809, not the selected 0.11.0-beta.3.vorteo.810. Restored and reloaded the previous launcher",
  );
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.liveBytes);
  expect(launchd.calls.filter((call) => call === "launchctl bootstrap")).toHaveLength(2);
});

test("a failed reload is reported with the fallback copy and never retried", async () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target, { bootstrapFails: true });
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest },
      {
        run: launchd.run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: 10, version: "0.11.0-beta.3.vorteo.810" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow("reload the Host service by hand");
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.liveBytes);
});

test("a changed plan refuses before touching anything", async () => {
  const f = fixture();
  const launchd = fakeLaunchd(f.target);
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest: "0".repeat(64) },
      {
        run: launchd.run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: 10, version: "x" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow("Nothing was changed");
  expect(launchd.calls).toEqual([]);
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.liveBytes);
  expect(existsSync(path.join(f.target.stateDir, "host-launcher-fallback-job.plist"))).toBe(false);
});

/** A Host that already selects managed releases, with a candidate that toggles release seals. */
function sealFixture(direction: "on" | "off") {
  const f = fixture();
  const managed = {
    ...live,
    EnvironmentVariables: {
      ...live.EnvironmentVariables,
      PASEO_MANAGED_RELEASE_LINK: f.link,
      PASEO_MANAGED_RELEASE_ROOT: f.releases,
    },
  };
  const sealed = {
    ...managed,
    EnvironmentVariables: { ...managed.EnvironmentVariables, VORTEO_RELEASE_SEALS: "enabled" },
  };
  const [before, after] = direction === "on" ? [managed, sealed] : [sealed, managed];
  const liveBytes = JSON.stringify(before);
  const candidateBytes = JSON.stringify(after);
  writeFileSync(f.target.plist, liveBytes);
  writeFileSync(f.target.candidate.path, candidateBytes);
  f.target.candidate.sha256 = createHash("sha256").update(candidateBytes).digest("hex");
  return { ...f, managed, sealed, liveBytes, candidateBytes };
}

test("on a managed launcher the candidate may add or remove only VORTEO_RELEASE_SEALS=enabled", () => {
  const f = sealFixture("on");
  const { managed, sealed } = f;
  const check = (current: unknown, candidate: unknown) =>
    verifyLauncherCandidate(current, candidate, f.link, f.releases);
  const withEnvironment = (base: typeof managed, environment: Record<string, string>) => ({
    ...base,
    EnvironmentVariables: { ...base.EnvironmentVariables, ...environment },
  });
  expect(check(managed, sealed)).toBe("release-seals-on");
  expect(check(sealed, managed)).toBe("release-seals-off");
  expect(check(live, { ...managed })).toBe("managed-release");

  for (const [current, candidate, message] of [
    // Any other value, variable or key.
    [
      managed,
      withEnvironment(managed, { VORTEO_RELEASE_SEALS: "1" }),
      "changes more than VORTEO_RELEASE_SEALS=enabled: EnvironmentVariables.VORTEO_RELEASE_SEALS",
    ],
    [
      managed,
      withEnvironment(sealed, { PATH: "/elsewhere" }),
      "changes more than VORTEO_RELEASE_SEALS=enabled: EnvironmentVariables.PATH",
    ],
    [
      managed,
      withEnvironment(managed, { OTHER: "enabled" }),
      "EnvironmentVariables.OTHER, EnvironmentVariables.VORTEO_RELEASE_SEALS",
    ],
    [
      managed,
      { ...sealed, KeepAlive: false },
      "changes more than VORTEO_RELEASE_SEALS=enabled: KeepAlive",
    ],
    [sealed, { ...managed, KeepAlive: false }, "KeepAlive"],
    // Seals cannot ride along with the managed release update.
    [
      live,
      withEnvironment(managed, { VORTEO_RELEASE_SEALS: "enabled" }),
      "changes more than the managed release link and root: EnvironmentVariables.VORTEO_RELEASE_SEALS",
    ],
    // Unexpected current launcher state.
    [
      withEnvironment(managed, { VORTEO_RELEASE_SEALS: "1" }),
      managed,
      "sets VORTEO_RELEASE_SEALS to a value other than enabled",
    ],
    [
      withEnvironment(managed, { PASEO_MANAGED_RELEASE_LINK: "/elsewhere" }),
      withEnvironment(sealed, { PASEO_MANAGED_RELEASE_LINK: "/elsewhere" }),
      "differs from the configured source updates",
    ],
    [
      { ...live, EnvironmentVariables: { PASEO_MANAGED_RELEASE_LINK: f.link } },
      sealed,
      "differs from the configured source updates",
    ],
    [{ ...managed, EnvironmentVariables: "x" }, sealed, "not a string dictionary"],
    [sealed, sealed, "already selects managed releases"],
  ] as const)
    expect(() => check(current, candidate), message).toThrow(message);
});

test("a release seal plan has its own digest and is not advertised once applied", () => {
  const on = sealFixture("on");
  const digest = hostLauncherPlanDigest(on.target, on.plistJson);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  // The same bytes as a managed release update would not share its digest.
  const managedDigest = createHash("sha256")
    .update(
      JSON.stringify({
        candidate: on.target.candidate.sha256,
        live: createHash("sha256").update(on.liveBytes).digest("hex"),
        link: on.target.link,
        root: on.target.root,
      }),
    )
    .digest("hex");
  expect(digest).not.toBe(managedDigest);
  writeFileSync(on.target.plist, on.candidateBytes);
  expect(hostLauncherPlanDigest(on.target, on.plistJson)).toBeUndefined();
});

test("turning release seals on restarts the whole Host and verifies the new supervisor carries them", async () => {
  const f = sealFixture("on");
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target);
  let pid = 10;
  const detail = await runHostLauncherUpdate(
    f.target,
    { jobId: "job", digest },
    {
      run: launchd.run,
      plistJson: f.plistJson,
      probe: async () => ({ pid: pid++, version: "0.11.0-beta.3.vorteo.810" }),
      ...clock(),
    },
  );
  expect(detail).toContain("release seals turned on");
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.candidateBytes);
  expect(
    readFileSync(path.join(f.target.stateDir, "host-launcher-fallback-job.plist"), "utf8"),
  ).toBe(f.liveBytes);
  expect(launchd.calls.filter((call) => call === "launchctl bootout")).toHaveLength(1);
  expect(launchd.calls.filter((call) => call === "launchctl bootstrap")).toHaveLength(1);
});

test("turning release seals off verifies the new supervisor no longer carries them", async () => {
  const f = sealFixture("off");
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target);
  let pid = 10;
  const detail = await runHostLauncherUpdate(
    f.target,
    { jobId: "job", digest },
    {
      run: launchd.run,
      plistJson: f.plistJson,
      probe: async () => ({ pid: pid++, version: "0.11.0-beta.3.vorteo.810" }),
      ...clock(),
    },
  );
  expect(detail).toContain("release seals turned off");
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.candidateBytes);
});

test("a supervisor that comes back without the seal setting restores the previous launcher", async () => {
  const f = sealFixture("on");
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target);
  // The reloaded supervisor reports the old environment, as if launchd kept the old plist.
  const run: EngineCommand = async (file, args, timeout) =>
    path.basename(file) === "ps"
      ? {
          stdout: `node supervisor-entrypoint.js ${Object.entries(f.managed.EnvironmentVariables)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}\n`,
        }
      : launchd.run(file, args, timeout);
  let pid = 10;
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest },
      {
        run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: pid++, version: "0.11.0-beta.3.vorteo.810" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow(
    "The new Host supervisor does not carry VORTEO_RELEASE_SEALS=enabled. Restored and reloaded the previous launcher",
  );
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.liveBytes);
});

test("a release seal plan changed after approval refuses before touching anything", async () => {
  const f = sealFixture("on");
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  writeFileSync(f.target.plist, JSON.stringify({ ...f.managed, KeepAlive: false }));
  const launchd = fakeLaunchd(f.target);
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest },
      {
        run: launchd.run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: 10, version: "x" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow("changes more than VORTEO_RELEASE_SEALS=enabled: KeepAlive");
  expect(launchd.calls).toEqual([]);
});
