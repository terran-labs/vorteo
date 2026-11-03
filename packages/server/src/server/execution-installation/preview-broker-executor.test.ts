import { createHash } from "node:crypto";
import { expect, test as platformTest, vi } from "vitest";
import { InstallationConfigSchema, type InstallationConfig } from "./config.js";
import { compatibilityProbe, createPreviewBrokerExecutor } from "./preview-broker-executor.js";

// Production attaches this executor only on macOS. These simulated fixtures use
// its POSIX path contract and can also run on Linux, but not Windows.
const test = platformTest.skipIf(process.platform === "win32");

const inputs = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("./coordinator-bootstrap-artifact.js", () => ({
  readBootstrapPreparedFile: async (file: { path: string; sha256: string }) => {
    const bytes = inputs.get(file.path);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw Error("Pinned input changed");
    return bytes;
  },
}));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  inputs.clear();
  const file = (path: string, text = path) => {
    inputs.set(path, Buffer.from(text));
    return { path, sha256: digest(text) };
  };
  const probe = compatibilityProbe("74233052-15e9-48cf-b214-df175c2d7955");
  const identity = file("/protected/channel_identity.py");
  const previewBroker = {
    docker: "/protected/docker",
    socket: "/protected/docker.sock",
    containerId: "a".repeat(64),
    configPaths: probe.plan.brokers.map((item) => item.configPath) as [string, string],
    python: file("/protected/python"),
    worker: file("/protected/worker.py"),
    identityModule: identity,
    evidenceRoot: "/protected/evidence",
    consumerFiles: ["native", "dev"].flatMap((name) =>
      ["https_broker.py", "channel_identity.py", "host_config.py", "https-preview.py"].map((base) =>
        file(`/protected/${name}/${base}`, base === "channel_identity.py" ? identity.path : base),
      ),
    ),
    recovery: {
      node: file("/protected/node"),
      journal: file("/protected/journal.js"),
      queue: file("/protected/queue.js"),
      configModule: file("/protected/config.js"),
    },
  };
  probe.plan.continuityEvidence = [file("/protected/continuity.json")];
  probe.planSha256 = digest(JSON.stringify(probe.plan));
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId: probe.plan.installationId,
      origin: "https://owner.example.test",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example.test", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.example.test", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: "/protected/web",
    stateDir: "/protected/state",
    ownerPasswordHash: "$2fixture",
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    host: { endpoint: "host", password: "fixture", launchdService: "gui/501/local.vorteo.fixture" },
    container: { endpoint: "dev", password: "fixture" },
    previewBroker,
  };
  const command = vi.fn(async (call: { executable: string; args: string[]; input?: string }) => {
    if (call.executable === previewBroker.recovery.node.path) return "broker-journal-config-v1";
    const request = JSON.parse(call.input!);
    if (request.operation === "inspect") return JSON.stringify({ ready: true });
    return JSON.stringify({
      status: "succeeded",
      serviceStarted: false,
      candidateHashes: probe.plan.brokers.map((item) => item.candidateSha256),
    });
  });
  const executable = vi.fn(async () => {});
  const executor = createPreviewBrokerExecutor(
    { config, writableMountRoots: async () => [] },
    { command, verifyExecutable: executable },
  );
  return { probe, config, command, executor, executable };
}

test("compatibility checks the selected parser and invokes the exact retained readers", async () => {
  const f = fixture();
  InstallationConfigSchema.parse(f.config);
  expect(await f.executor.brokerCompatible()).toBe(true);
  expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.executable).toHaveBeenCalledWith(f.config.previewBroker!.python, []);
  expect(f.executable).toHaveBeenCalledWith(f.config.previewBroker!.recovery.node, []);
  const call = f.command.mock.calls[0]![0];
  expect(call.executable).toBe(f.config.previewBroker!.recovery.node.path);
  expect(call).toMatchObject({
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", NODE_OPTIONS: "" },
  });
  expect(call.args).toEqual([
    "--input-type=module",
    "-e",
    expect.stringContaining("probe cannot write"),
  ]);
  expect(JSON.parse(call.input!).jobs[0].target).toBe("preview-broker");
});

test("an older recovery parser refuses before the worker can run", async () => {
  const f = fixture();
  f.command.mockRejectedValue(new Error("Unknown target"));
  await expect(f.executor.validateBrokerPlan(f.probe.plan)).rejects.toThrow("compatible");
  expect(
    f.command.mock.calls.every(
      ([call]) => call.executable === f.config.previewBroker!.recovery.node.path,
    ),
  ).toBe(true);
});

test("missing or changed consumer pins prevent compatibility", async () => {
  const f = fixture();
  inputs.set(f.config.previewBroker!.consumerFiles[0]!.path, Buffer.from("foreign"));
  expect(await f.executor.brokerCompatible()).toBe(false);
  expect(f.command).not.toHaveBeenCalled();
});

test("foreign evidence or fence paths refuse without invoking any process", async () => {
  const f = fixture();
  await expect(
    f.executor.validateBrokerPlan({ ...f.probe.plan, evidenceDirectory: "/foreign" }),
  ).rejects.toThrow("footprint");
  f.probe.plan.brokers[0].fencePath = "/foreign";
  await expect(f.executor.validateBrokerPlan(f.probe.plan)).rejects.toThrow("footprint");
  expect(f.command).not.toHaveBeenCalled();
});

test("worker invocation binds isolated Python, exact plan and fixed config allowlist", async () => {
  const f = fixture();
  await f.executor.validateBrokerPlan(f.probe.plan);
  const call = f.command.mock.calls.at(-1)![0];
  expect(call.args.slice(0, 3)).toEqual(["-I", "-B", "-c"]);
  expect(JSON.parse(call.input!)).toEqual({
    operation: "inspect",
    plan: f.probe.plan,
    allowedConfigs: f.config.previewBroker!.configPaths,
    evidenceRoot: "/protected/evidence",
  });
});

test("unapproved or changed dispatch cannot invoke the worker", async () => {
  const f = fixture();
  await expect(f.executor.installBroker(f.probe)).rejects.toThrow("approved plan");
  expect(f.command).not.toHaveBeenCalled();
});
