import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// A daemon log rotated away between listing its folder and copying it: the snapshot of a
// live Host home must skip it, not fail (seen on a real upgrade).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: ((file: string, ...rest: unknown[]) =>
      String(file).endsWith("rotated-away.log")
        ? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
        : (actual.lstat as (...args: unknown[]) => unknown)(file, ...rest)) as typeof actual.lstat,
  };
});
import type { ManagedService, ServiceControl } from "./service-control.js";
import { createServiceControl, managedServices } from "./service-control.js";
import {
  createInstallationSnapshots,
  executeRestore,
  planRestore,
  snapshotPartKinds,
  snapshotSources,
  devHomeThroughContainer,
  mountedHomeScript,
  RestoreRollbackError,
  type MountedHomeRestore,
  type SnapshotSource,
  type StoredPart,
} from "./snapshots.js";
import { execFileSync } from "node:child_process";
import { InstallationConfigSchema } from "./config.js";

// Host snapshots and upgrades run only on macOS and Linux Hosts; Windows Hosts are #35.
const posixTest = test.skipIf(process.platform === "win32");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "installation-snapshots-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A Host home, a Dev home and a deployment directory with caches to leave out. */
function installation() {
  const state = path.join(root, "vorteo/state/coordinator");
  const host = path.join(root, "vorteo/host/home");
  const container = path.join(root, "vorteo/container");
  const config = path.join(root, "vorteo/host/coordinator.json");
  write(path.join(state, "restarts.json"), "[]");
  write(path.join(host, "config.json"), '{"daemon":{}}');
  write(path.join(host, "rotated-away.log"), "log");
  write(path.join(host, ".cache/huge.bin"), "cache");
  write(path.join(container, "data/home/.bashrc"), "export A=1");
  write(path.join(container, "data/home/.npm/_cacache/x"), "cache");
  write(path.join(container, "data/home/project/.cache/y"), "cache");
  write(path.join(container, ".env"), "PASEO_IMAGE=old");
  write(path.join(container, "compose.yaml"), "services: {}");
  write(path.join(container, "workspace/file"), "work");
  write(config, "{}");
  const sources: SnapshotSource[] = [
    { type: "directory", kind: "coordinator-state", path: state },
    { type: "file", kind: "deployment", path: config },
    { type: "directory", kind: "host-home", path: host },
    { type: "directory", kind: "dev-home", path: path.join(container, "data/home") },
    {
      type: "directory",
      kind: "deployment",
      path: container,
      excludeTopLevel: ["data", "workspace", "logs"],
    },
  ];
  return { state, host, container, config, sources };
}

function snapshots(sources: SnapshotSource[], now = () => new Date("2026-10-30T12:00:00Z")) {
  return createInstallationSnapshots({
    root: path.join(root, "vorteo/state/snapshots"),
    sources: () => sources,
    ports: {
      now,
      exportDocker: async () => undefined,
      importDocker: async () => undefined,
    },
  });
}

posixTest("captures every part with a manifest and leaves caches out", async () => {
  const { sources, container } = installation();
  const service = snapshots(sources);
  const snapshot = await service.take({ reason: "owner" });
  expect(snapshot.id).toBe("20261030T120000000Z");
  expect(snapshot.parts.map((part) => part.kind)).toEqual([
    "coordinator-state",
    "deployment",
    "host-home",
    "dev-home",
    "deployment",
  ]);
  expect(snapshotPartKinds(snapshot)).toEqual([
    "coordinator-state",
    "deployment",
    "dev-home",
    "host-home",
  ]);
  const manifest = JSON.parse(
    readFileSync(path.join(service.root, snapshot.id, "manifest.json"), "utf8"),
  );
  expect(manifest).toEqual(snapshot);
  const stored = service.storedParts(snapshot);
  expect(existsSync(path.join(stored[2].stored, "config.json"))).toBe(true);
  expect(existsSync(path.join(stored[2].stored, ".cache"))).toBe(false);
  expect(existsSync(path.join(stored[2].stored, "rotated-away.log"))).toBe(false);
  expect(existsSync(path.join(stored[3].stored, ".bashrc"))).toBe(true);
  expect(existsSync(path.join(stored[3].stored, ".npm"))).toBe(false);
  expect(existsSync(path.join(stored[3].stored, "project/.cache"))).toBe(false);
  expect(existsSync(path.join(stored[4].stored, ".env"))).toBe(true);
  expect(existsSync(path.join(stored[4].stored, "data"))).toBe(false);
  expect(existsSync(path.join(stored[4].stored, "workspace"))).toBe(false);
  expect(snapshot.parts[4]).toMatchObject({ source: container, files: 2 });
  expect(service.list()).toEqual([snapshot]);
});

test("keeps the newest five and never prunes a protected snapshot", async () => {
  const { sources } = installation();
  let time = Date.parse("2026-10-30T12:00:00Z");
  const service = snapshots(sources, () => new Date(time));
  const ids: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    ids.push((await service.take({ reason: "owner" })).id);
    time += 60_000;
  }
  expect(service.prune([ids[0]])).toEqual([ids[1]]);
  expect(service.list().map((item) => item.id)).toEqual([...ids.slice(2).toReversed(), ids[0]]);
});

test("a failed capture leaves no partial snapshot behind", async () => {
  const { sources } = installation();
  const service = createInstallationSnapshots({
    root: path.join(root, "vorteo/state/snapshots"),
    sources: () => [
      ...sources,
      { type: "docker", kind: "dev-home", docker: "/bin/docker", container: "dev", path: "/home" },
    ],
    ports: {
      now: () => new Date("2026-10-30T12:00:00Z"),
      exportDocker: async () => {
        throw new Error("docker unavailable");
      },
      importDocker: async () => undefined,
    },
  });
  await expect(service.take({ reason: "owner" })).rejects.toThrow("docker unavailable");
  expect(service.list()).toEqual([]);
  expect(readdir(service.root)).toEqual([]);
});

function readdir(directory: string) {
  return existsSync(directory) ? readdirSync(directory) : [];
}

function recordingServices(calls: string[], failStart?: ManagedService): ServiceControl {
  return {
    stop: async (service) => {
      calls.push(`stop ${service}`);
    },
    start: async (service) => {
      calls.push(`start ${service}`);
      if (service === failStart) throw new Error(`${service} did not start`);
    },
    restart: async (service) => {
      calls.push(`restart ${service}`);
    },
  };
}

posixTest(
  "restore stops services, replaces each part, then starts Dev, the Host and the coordinator",
  async () => {
    const { sources, host, container, state } = installation();
    const service = snapshots(sources);
    const snapshot = await service.take({ reason: "owner" });
    write(path.join(host, "config.json"), '{"changed":true}');
    write(path.join(host, "new-file"), "after snapshot");
    write(path.join(container, ".env"), "PASEO_IMAGE=new");
    write(path.join(container, "workspace/kept"), "unrelated");
    const parts = service.storedParts(snapshot);
    const steps = planRestore(parts, true);
    expect(steps.filter((step) => step.action !== "restore")).toEqual([
      { action: "stop", service: "coordinator" },
      { action: "stop", service: "host" },
      { action: "stop", service: "dev" },
      { action: "start", service: "dev" },
      { action: "start", service: "host" },
      { action: "start", service: "coordinator" },
      { action: "verify-coordinator" },
    ]);
    const calls: string[] = [];
    await executeRestore({
      restoreId: "00000000-0000-4000-8000-000000000001",
      parts,
      steps,
      ports: {
        services: recordingServices(calls),
        snapshot: { importDocker: async () => undefined },
        verifyCoordinator: async () => {
          calls.push("verify");
        },
        progress: () => undefined,
      },
    });
    expect(calls).toEqual([
      "stop coordinator",
      "stop host",
      "stop dev",
      "start dev",
      "start host",
      "start coordinator",
      "verify",
    ]);
    expect(readFileSync(path.join(host, "config.json"), "utf8")).toBe('{"daemon":{}}');
    expect(existsSync(path.join(host, "new-file"))).toBe(false);
    expect(readFileSync(path.join(container, ".env"), "utf8")).toBe("PASEO_IMAGE=old");
    expect(readFileSync(path.join(container, "workspace/kept"), "utf8")).toBe("unrelated");
    expect(existsSync(path.join(state, "restarts.json"))).toBe(true);
    expect(existsSync(`${host}.before-restore-00000000-0000-4000-8000-000000000001`)).toBe(false);
  },
);

posixTest(
  "a failed restore puts every replaced part back and starts the services again",
  async () => {
    const { sources, host } = installation();
    const service = snapshots(sources);
    const snapshot = await service.take({ reason: "owner" });
    write(path.join(host, "config.json"), '{"changed":true}');
    const parts = service.storedParts(snapshot);
    const calls: string[] = [];
    await expect(
      executeRestore({
        restoreId: "00000000-0000-4000-8000-000000000002",
        parts,
        steps: planRestore(parts, false),
        ports: {
          services: recordingServices(calls, "host"),
          snapshot: { importDocker: async () => undefined },
          verifyCoordinator: async () => undefined,
          progress: () => undefined,
        },
      }),
    ).rejects.toThrow("host did not start");
    expect(readFileSync(path.join(host, "config.json"), "utf8")).toBe('{"changed":true}');
    // The failed start may have launched the Host, so it stops before files go back.
    expect(calls).toEqual([
      "stop coordinator",
      "stop host",
      "start host",
      "stop host",
      "start host",
      "start coordinator",
    ]);
  },
);

posixTest(
  "a bind-mounted Dev home is replaced, then kept or put back with the restore",
  async () => {
    const source = {
      type: "docker" as const,
      kind: "dev-home" as const,
      docker: "/usr/bin/docker",
      container: "paseo-x-paseo-1",
      path: "/home/paseo",
      mounted: true as const,
    };
    const part = {
      part: { kind: "dev-home", source: "docker:paseo-x-paseo-1:/home/paseo" },
      source,
      stored: "/snapshot/dev-home.tar",
    } as unknown as StoredPart;
    const run = async (failStart?: ManagedService) => {
      const calls: string[] = [];
      const mounted: MountedHomeRestore = {
        replace: async (_source, file) => void calls.push(`replace ${file}`),
        revert: async () => void calls.push("revert"),
        discard: async () => void calls.push("discard"),
      };
      await executeRestore({
        restoreId: "r1",
        parts: [part],
        steps: planRestore([part], true),
        ports: {
          services: recordingServices([], failStart),
          snapshot: { importDocker: async () => void calls.push("overlay"), mounted },
          verifyCoordinator: async () => undefined,
          progress: () => undefined,
        },
      }).catch(() => calls.push("failed"));
      return calls;
    };
    expect(await run()).toEqual(["replace /snapshot/dev-home.tar", "discard"]);
    expect(await run("host")).toEqual(["replace /snapshot/dev-home.tar", "revert", "failed"]);
  },
);

posixTest("a late restore failure stops started services before putting files back", async () => {
  const source = {
    type: "docker" as const,
    kind: "dev-home" as const,
    docker: "/usr/bin/docker",
    container: "c",
    path: "/home/paseo",
    mounted: true as const,
  };
  const part = {
    part: { kind: "dev-home", source: "dev" },
    source,
    stored: "/s.tar",
  } as unknown as StoredPart;
  const calls: string[] = [];
  const error = await executeRestore({
    restoreId: "r2",
    parts: [part],
    steps: planRestore([part], true),
    ports: {
      services: recordingServices(calls),
      snapshot: {
        importDocker: async () => undefined,
        mounted: {
          replace: async () => undefined,
          revert: async () => {
            calls.push("revert");
            throw new Error("mv failed");
          },
          discard: async () => undefined,
        },
      },
      verifyCoordinator: async () => {
        throw new Error("coordinator did not answer");
      },
      progress: () => undefined,
    },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RestoreRollbackError);
  expect(String(error)).toMatch(/coordinator did not answer.*mv failed/);
  // Dev, the Host and the coordinator were running again; all stop before the revert.
  const revertAt = calls.indexOf("revert");
  expect(calls.slice(revertAt - 3, revertAt)).toEqual([
    "stop coordinator",
    "stop host",
    "stop dev",
  ]);
  // Nothing starts on partially recovered data.
  expect(calls.slice(revertAt + 1)).toEqual([]);
});

posixTest(
  "a Dev that fails its start is stopped, and a stop that fails leaves files alone",
  async () => {
    const source = {
      type: "docker" as const,
      kind: "dev-home" as const,
      docker: "/usr/bin/docker",
      container: "c",
      path: "/home/paseo",
      mounted: true as const,
    };
    const part = {
      part: { kind: "dev-home", source: "dev" },
      source,
      stored: "/s.tar",
    } as unknown as StoredPart;
    const attempt = async (stopFails: boolean) => {
      const calls: string[] = [];
      const services = recordingServices(calls, "dev");
      const error = await executeRestore({
        restoreId: "r4",
        parts: [part],
        steps: planRestore([part], true),
        ports: {
          services: {
            ...services,
            stop: async (service) => {
              calls.push(`stop ${service}`);
              if (stopFails && calls.includes("start dev")) throw new Error("still running");
            },
          },
          snapshot: {
            importDocker: async () => undefined,
            mounted: {
              replace: async () => undefined,
              revert: async () => void calls.push("revert"),
              discard: async () => undefined,
            },
          },
          verifyCoordinator: async () => undefined,
          progress: () => undefined,
        },
      }).catch((caught: unknown) => caught);
      return { calls, error };
    };
    const ok = await attempt(false);
    expect(ok.calls.slice(ok.calls.indexOf("start dev") + 1)).toEqual([
      "stop dev",
      "revert",
      "start dev",
      "start host",
      "start coordinator",
    ]);
    const stuck = await attempt(true);
    expect(stuck.error).toBeInstanceOf(RestoreRollbackError);
    expect(stuck.calls).not.toContain("revert");
  },
);

posixTest("the mounted home export script archives the home without excluded entries", () => {
  const home = path.join(root, "home");
  write(path.join(home, ".config/settings"), "settings");
  write(path.join(home, ".cache/blob"), "cache");
  write(path.join(home, ".before-restore-r0/old.txt"), "aside");
  const archive = execFileSync("/bin/sh", [
    "-c",
    mountedHomeScript("export"),
    "restore",
    home,
    "--exclude=./.before-restore-*",
    "--exclude=.cache",
  ]);
  const listing = execFileSync("tar", ["-tf", "-"], { input: archive }).toString();
  expect(listing).toContain(".config/settings");
  expect(listing).not.toContain(".cache");
  expect(listing).not.toContain(".before-restore-");
});

posixTest("the mounted home scripts replace, put back and discard the contents", () => {
  const home = path.join(root, "home");
  write(path.join(home, "old.txt"), "old");
  write(path.join(home, ".config/settings"), "old settings");
  const snapshot = path.join(root, "snapshot");
  write(path.join(snapshot, "kept.txt"), "from snapshot");
  const archive = path.join(root, "home.tar");
  execFileSync("tar", ["-C", snapshot, "-cf", archive, "."]);
  const sh = (action: "replace" | "revert" | "discard", input?: Buffer) =>
    execFileSync("/bin/sh", ["-c", mountedHomeScript(action), "restore", home, "r1"], { input });
  sh("replace", readFileSync(archive));
  const entries = () => readdirSync(home).filter((name) => !name.startsWith(".before-restore-"));
  expect(entries()).toEqual(["kept.txt"]);
  sh("revert");
  expect(readdirSync(home).sort()).toEqual([".config", "old.txt"]);
  expect(readFileSync(path.join(home, ".config/settings"), "utf8")).toBe("old settings");
  sh("replace", readFileSync(archive));
  sh("discard");
  expect(readdirSync(home)).toEqual(["kept.txt"]);
});

posixTest.skipIf(process.getuid?.() === 0)(
  "a move that fails midway leaves untouched originals in place for the revert",
  () => {
    const home = path.join(root, "home");
    for (const name of ["a", "b", "c"]) write(path.join(home, name, "file"), name);
    // Moving a directory needs write access to it, for its parent link.
    chmodSync(path.join(home, "b"), 0o555);
    const sh = (action: "replace" | "revert", input?: Buffer) =>
      execFileSync("/bin/sh", ["-c", mountedHomeScript(action), "restore", home, "r3"], {
        input,
        stdio: ["pipe", "ignore", "ignore"],
      });
    expect(() => sh("replace", Buffer.from(""))).toThrow();
    sh("revert");
    chmodSync(path.join(home, "b"), 0o755);
    expect(readdirSync(home).sort()).toEqual(["a", "b", "c"]);
    for (const name of ["a", "b", "c"])
      expect(readFileSync(path.join(home, name, "file"), "utf8")).toBe(name);
  },
);

posixTest("snapshot sources follow the installation layout", () => {
  const { container } = installation();
  const config = InstallationConfigSchema.parse({
    public: {
      version: 1,
      installationId: "00000000-0000-4000-8000-000000000001",
      origin: "http://localhost:4000",
      environments: [
        { kind: "host", serverId: "host", endpoint: "127.0.0.1:1", useTls: false },
        { kind: "container", serverId: "dev", endpoint: "127.0.0.1:2", useTls: false },
      ],
    },
    listenPort: 4000,
    webDistDir: "/fixture/web",
    stateDir: "/fixture/state",
    ownerPasswordHash: "$2-fixture",
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    host: {
      endpoint: "127.0.0.1:1",
      password: "host",
      launchdService: "gui/501/local.vorteo.fixture.host",
      startupValidation: { node: "/node", entrypoint: "/entry", home: "/fixture/host-home" },
    },
    container: { endpoint: "127.0.0.1:2", password: "container" },
    deployment: {
      installRoot: "/fixture",
      sourceDirectory: "/fixture/source",
      containerDirectory: container,
    },
  });
  expect(snapshotSources(config, "/fixture/coordinator.json")).toEqual([
    { type: "directory", kind: "coordinator-state", path: "/fixture/state" },
    { type: "file", kind: "deployment", path: "/fixture/coordinator.json" },
    { type: "directory", kind: "host-home", path: "/fixture/host-home" },
    { type: "directory", kind: "dev-home", path: path.join(container, "data/home") },
    {
      type: "directory",
      kind: "deployment",
      path: container,
      excludeTopLevel: ["data", "workspace", "logs"],
    },
  ]);
  // Linux keeps Dev's home private to the container's user: it goes through the container.
  const linux = devHomeThroughContainer(snapshotSources(config, "/fixture/coordinator.json"), {
    platform: "linux",
    docker: "/usr/bin/docker",
    container: "paseo-x-paseo-1",
  });
  expect(linux.find((source) => source.kind === "dev-home")).toEqual({
    type: "docker",
    kind: "dev-home",
    docker: "/usr/bin/docker",
    container: "paseo-x-paseo-1",
    path: "/home/paseo",
    mounted: true,
  });
  expect(
    devHomeThroughContainer(linux, { platform: "darwin", docker: "/d", container: "c" }),
  ).toEqual(linux);
  const { container: _dev, deployment: _deployment, ...hostOnly } = config;
  const hostOnlySources = snapshotSources(
    { ...hostOnly, public: { ...config.public, environments: [config.public.environments[0]] } },
    "/fixture/coordinator.json",
  );
  expect(hostOnlySources.map((source) => source.kind)).toEqual([
    "coordinator-state",
    "deployment",
    "host-home",
  ]);
  // A Dev the installer does not manage (adopted without containerDirectory) is neither
  // captured nor stopped: snapshots and restores cover the Host only.
  const { containerDirectory: _directory, ...hostDeployment } = config.deployment!;
  const unmanaged = { ...config, deployment: hostDeployment };
  expect(snapshotSources(unmanaged, "/fixture/coordinator.json").map((s) => s.kind)).toEqual([
    "coordinator-state",
    "deployment",
    "host-home",
  ]);
  expect(managedServices(unmanaged)).not.toHaveProperty("dev");
});

posixTest(
  "service control uses launchd, systemd user units and Dev's own Compose helpers",
  async () => {
    const calls: string[][] = [];
    const control = createServiceControl(
      {
        coordinator: { launchdService: "gui/501/local.vorteo.fixture.installation" },
        host: {
          systemdService: {
            kind: "systemd-user",
            uid: 1000,
            unit: "local.vorteo.fixture.host.service",
          },
        },
        dev: { directory: "/fixture/container" },
      },
      async (command, args) => {
        calls.push([command, ...args]);
        return "";
      },
      "/Users/owner/Library/LaunchAgents",
    );
    await control.stop("coordinator");
    await control.start("coordinator");
    await control.restart("coordinator");
    await control.restart("host");
    await control.stop("dev");
    expect(calls.slice(0, 4)).toEqual([
      ["/bin/launchctl", "bootout", "gui/501/local.vorteo.fixture.installation"],
      [
        "/bin/launchctl",
        "bootstrap",
        "gui/501",
        "/Users/owner/Library/LaunchAgents/local.vorteo.fixture.installation.plist",
      ],
      ["/bin/launchctl", "kickstart", "-k", "gui/501/local.vorteo.fixture.installation"],
      ["/usr/bin/systemctl", "--user", "restart", "local.vorteo.fixture.host.service"],
    ]);
    expect(calls[4][0]).toBe("/bin/bash");
    expect(calls[4].at(-1)).toBe("/fixture/container");
    expect(calls[4][2]).toContain("paseo_compose stop paseo");
  },
);
