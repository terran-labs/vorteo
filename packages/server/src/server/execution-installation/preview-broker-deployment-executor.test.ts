import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test as platformTest, vi } from "vitest";
import { createPreviewBrokerDeploymentExecutor } from "./preview-broker-deployment-executor.js";
import { PreviewBrokerDeploymentJobSchema } from "@getpaseo/protocol/preview-broker-deployment";
import type { InstallationConfig } from "./config.js";

// The production executor and its native Python transport are macOS-only.
const test = platformTest.skipIf(process.platform !== "darwin");

const state = vi.hoisted(() => ({
  inputs: new Map<string, Buffer>(),
  children: [] as Array<{ pid: number; executable: string; args: string[] }>,
  inspect: undefined as undefined | (() => void),
  wrongParent: false,
}));
const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (file: string, args: string[], options: import("node:child_process").SpawnOptions) => {
      const child = actual.spawn(file, args, options);
      state.children.push({ pid: child.pid!, executable: file, args });
      return child;
    },
  };
});
vi.mock("./coordinator-bootstrap-artifact.js", () => ({
  assertBootstrapPathsProtected: async () => {},
  readBootstrapPreparedFile: async (pin: { path: string; sha256: string }) => {
    const raw = state.inputs.get(pin.path);
    if (!raw || hash(raw) !== pin.sha256) throw Error("Synthetic protected input changed");
    return raw;
  },
}));
vi.mock("./preview-monitor-executor.js", () => ({
  verifyExecutable: async () => {},
  monitorCommand: async () => "deployment-reader-v1",
}));
const boot = "cd13c679-6d66-4a9f-ae63-fdb69c27a51e";
vi.mock("./coordinator-bootstrap-service.js", () => ({
  createNativeBootstrapServiceReader: async () => ({
    inspectRunningProcess: async (pid: number) => {
      const child = state.children.find((item) => item.pid === pid)!;
      state.inspect?.();
      return {
        pid,
        parentPid: state.wrongParent ? 1 : process.pid,
        uid: process.getuid!(),
        bootId: boot,
        startIdentity: "1:2",
        argumentsSha256: hash(JSON.stringify([child.executable, ...child.args])),
        executable: child.executable,
        stopped: false,
      };
    },
  }),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(mode = "normal", scopeBoot = boot) {
  state.inputs.clear();
  state.children = [];
  state.inspect = undefined;
  state.wrongParent = false;
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "deployment-transport-")));
  directories.push(directory);
  const requestId = randomUUID();
  const pin = (file: string, bytes = file) => {
    state.inputs.set(file, Buffer.from(bytes));
    return { path: file, sha256: hash(bytes) };
  };
  const roots: [string, string] = ["/fixture/host", "/fixture/dev"];
  const bindings = roots.map((root, index) => ({
    root,
    domain: `gui/${process.getuid!()}`,
    label: `local.test.${index}`,
    plist: pin(`/fixture/${index}.plist`),
    interpreter: "/fixture/python",
    argv: ["/fixture/python", "-I", `${root}/https_broker.py`],
  })) as NonNullable<InstallationConfig["previewBrokerDeployment"]>["bindings"];
  // Each request gets its own private evidence directory.
  const actualDirectory = path.join(directory, requestId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(actualDirectory, { mode: 0o700 });
  const actual = await stat(actualDirectory);
  const scope = pin(
    "/fixture/scope.json",
    JSON.stringify({
      version: 1,
      installationId: boot,
      requestId,
      bootUUID: scopeBoot,
      validUntil: new Date(Date.now() + 600_000).toISOString(),
      declaration:
        "Only the declared managed routes and manual participants are known; no new manual broker calls until release",
      bindings,
      manualParticipants: [],
    }),
  );
  const worker = pin(
    "/fixture/worker.py",
    `import sys,json,socket,time\ndef coordinator_main():\n p=json.load(sys.stdin)\n s=socket.socket(fileno=3)\n f=s.makefile('rwb',buffering=0)\n mode=${JSON.stringify(mode)}\n if mode=='eof': return\n for seq in (1,2):\n  message={'session':p['session'],'sequence':seq,'operation':'guard'}\n  if mode=='session': message['session']='wrong'\n  if mode=='sequence': message['sequence']=9\n  line=json.dumps(message)+'\\n'\n  if mode=='oversize': line='x'*5000+'\\n'\n  f.write(line.encode())\n  reply=f.readline(4096)\n  if not reply: raise ValueError('parent closed')\n  if json.loads(reply)!={**message,'admitted':True}: raise ValueError('parent refused')\n print(json.dumps({'kind':'committed','id':p['plan']['id'],'planSha256':p['planSha256'],'commitSha256':'a'*64,'preservationSha256':'b'*64,'registrationsSha256':'c'*64,'installedFilesSha256':'d'*64}))\n`,
  );
  const configuration: NonNullable<InstallationConfig["previewBrokerDeployment"]> = {
    docker: "/fixture/docker",
    socket: "/fixture/socket",
    containerId: "a".repeat(64),
    roots,
    bindings,
    scope,
    nativeInspector: pin("/fixture/inspector"),
    python: pin("/usr/bin/python3"),
    worker,
    modules: [
      "channel_identity",
      "broker_rebind",
      "broker_deployment",
      "broker_deployment_kernel",
      "broker_deployment_observation",
    ].map((name) => pin(`/fixture/${name}.py`, "# inert transport module")),
    evidenceRoot: directory,
    recovery: {
      node: pin("/fixture/node"),
      journal: pin("/fixture/journal"),
      queue: pin("/fixture/queue"),
      configModule: pin("/fixture/config-module"),
    },
  };
  const candidate = pin("/fixture/candidate");
  const consumer = {
    expected: { kind: "present", sha256: candidate.sha256, identity: Array(9).fill("1") },
    candidate,
    mode: 0o600,
  };
  const plan = {
    version: 1,
    operation: "preview-broker-consumer-deployment",
    id: requestId,
    installationId: boot,
    bootUUID: boot,
    sourceCommit: "a".repeat(40),
    evidenceDirectory: actualDirectory,
    evidenceDirectoryIdentity: [
      actual.dev,
      actual.ino,
      actual.uid,
      actual.gid,
      actual.mode & 0o777,
    ],
    targets: roots.map((root) => ({
      root,
      directory: [1, 2, 501, 20, 448],
      preservationSha256: "a".repeat(64),
      files: {
        "https_broker.py": consumer,
        "https-preview.py": consumer,
        "host_config.py": consumer,
        "channel_identity.py": { ...consumer, expected: { kind: "absent" } },
      },
    })),
    registrations: bindings.map((binding) => ({
      root: binding.root,
      domain: binding.domain,
      label: binding.label,
      plist: binding.plist,
      disposition: "absent",
      process: null,
      enabled: true,
      override: "absent",
    })),
    participantEvidence: [scope],
    manualParticipants: [],
  };
  const job = PreviewBrokerDeploymentJobSchema.parse({
    target: "preview-broker-deployment",
    operation: plan.operation,
    id: requestId,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Transport fixture",
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    plan,
    planSha256: hash(JSON.stringify(plan)),
    status: "running",
    stage: "dispatch_pending",
    detail: "Synthetic transport only",
  });
  job.planSha256 = hash(JSON.stringify(job.plan));
  const config = {
    public: { installationId: boot },
    previewBrokerDeployment: configuration,
  } as InstallationConfig;
  const configPin = pin("/fixture/config.json", JSON.stringify(config));
  const executor = createPreviewBrokerDeploymentExecutor({
    config,
    configurationFile: configPin,
    assertActive() {},
    writableMountRoots: async () => [],
  });
  return { executor, job, directory: actualDirectory, scope, configPin };
}

test("real private transport preserves once-only dispatch and read-only observation", async () => {
  const f = await fixture();
  const result = await f.executor.executeBrokerDeployment(f.job, () => {});
  expect(result.kind).toBe("committed");
  const before = await readdir(f.directory);
  expect(before.sort()).toEqual(["child-intent.json", "child-spawned.json"]);
  await expect(f.executor.executeBrokerDeployment(f.job, () => {})).rejects.toThrow();
  expect(state.children).toHaveLength(1);
  expect((await f.executor.observeBrokerDeployment(f.job)).kind).toBe("committed");
  expect(await readdir(f.directory)).toEqual(before);
});

test.each(["session", "sequence", "oversize", "eof"])(
  "private transport refuses %s without another attempt",
  async (mode) => {
    const f = await fixture(mode);
    await expect(f.executor.executeBrokerDeployment(f.job, () => {})).rejects.toThrow();
    await expect(f.executor.executeBrokerDeployment(f.job, () => {})).rejects.toThrow();
    expect(state.children).toHaveLength(1);
  },
);

test.each(["queue", "scope", "config", "custody", "deadline"])(
  "private transport refuses %s revocation before admission",
  async (mode) => {
    const f = await fixture();
    let revoked = false;
    state.inspect = () => {
      revoked = true;
      if (mode === "scope") state.inputs.set(f.scope.path, Buffer.from("changed"));
      if (mode === "config") state.inputs.set(f.configPin.path, Buffer.from("changed"));
      if (mode === "deadline") {
        const expired = Date.now() + 121_000;
        vi.spyOn(Date, "now").mockReturnValue(expired);
      }
    };
    state.wrongParent = mode === "custody";
    await expect(
      f.executor.executeBrokerDeployment(f.job, () => {
        if (mode === "queue" && revoked) throw Error("Queue reservation changed");
      }),
    ).rejects.toThrow();
    expect(state.children).toHaveLength(1);
  },
);

test("changed evidence directory custody refuses before spawning", async () => {
  const f = await fixture();
  f.job.plan.evidenceDirectoryIdentity[1] += 1;
  f.job.planSha256 = hash(JSON.stringify(f.job.plan));
  await expect(f.executor.executeBrokerDeployment(f.job, () => {})).rejects.toThrow(
    "Prepared evidence directory identity changed",
  );
  expect(state.children).toHaveLength(0);
  expect(await readdir(f.directory)).toEqual([]);
});

test("scope boot UUID written in uppercase still matches the plan", async () => {
  // sysctl prints the boot session UUID in uppercase; the kernel adapter lowercases it.
  const f = await fixture("normal", boot.toUpperCase());
  expect((await f.executor.executeBrokerDeployment(f.job, () => {})).kind).toBe("committed");
});

test("scope from a different boot refuses before spawning", async () => {
  const f = await fixture("normal", randomUUID());
  await expect(f.executor.executeBrokerDeployment(f.job, () => {})).rejects.toThrow(
    "Deployment scope differs from protected participant custody",
  );
  expect(state.children).toHaveLength(0);
});
