import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import pino from "pino";
import type { BrowserAutomationExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserToolsBroker } from "./broker.js";
import { startEmbeddedHeadlessHost } from "./embedded-headless-host.js";
import {
  spawnHeadlessHostProcess,
  type HeadlessHostProcess,
  type HeadlessHostProcessExit,
} from "./engine/headless-host-process-client.js";
import {
  parseHeadlessHostParentMessage,
  type HeadlessHostProcessOptions,
} from "./engine/headless-host-process-protocol.js";

const logger = pino({ level: "silent" });
const ENABLED = { daemon: { browserTools: { headlessHost: { enabled: true } } } };

class FakeHostProcess implements HeadlessHostProcess {
  public readonly requests: BrowserAutomationExecuteRequest[] = [];
  public closed = false;
  public readonly exited: Promise<HeadlessHostProcessExit>;
  private exit: (value: HeadlessHostProcessExit) => void = () => {};

  public constructor(private readonly startupError: Error | null = null) {
    this.exited = new Promise((resolve) => {
      this.exit = resolve;
    });
    if (startupError) this.crash();
  }

  public async ready(): Promise<void> {
    if (this.startupError) throw this.startupError;
  }

  public async execute(request: BrowserAutomationExecuteRequest) {
    await this.ready();
    this.requests.push(request);
    return {
      requestId: request.requestId,
      ok: true as const,
      result: { command: "list_tabs" as const, tabs: [] },
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.crash();
  }

  public crash(): void {
    this.exit({ code: 1, signal: null });
  }
}

function createSpawner(failures = 0) {
  const spawned: HeadlessHostProcessOptions[] = [];
  const processes: FakeHostProcess[] = [];
  let remainingFailures = failures;
  async function spawn(options: HeadlessHostProcessOptions): Promise<HeadlessHostProcess> {
    spawned.push(options);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return new FakeHostProcess(new Error("Chromium is not installed"));
    }
    const process = new FakeHostProcess();
    processes.push(process);
    return process;
  }
  return { spawn, spawned, processes };
}

function createClock() {
  let time = 1_000_000;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
}

function listTabs(broker: BrowserToolsBroker) {
  return broker.execute({
    command: { command: "list_tabs", args: {} },
    workspaceId: "wks_a",
    timeoutMs: 1_000,
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startEmbeddedHeadlessHost", () => {
  test("registers nothing unless enabled", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();

    startEmbeddedHeadlessHost({ broker, persisted: {}, logger });
    const disabled = startEmbeddedHeadlessHost({
      broker,
      persisted: { daemon: { browserTools: { headlessHost: { enabled: false } } } },
      logger,
      spawn: spawner.spawn,
    });

    expect(broker.getRegisteredClientCount()).toBe(0);
    await disabled.stop();
    expect(spawner.spawned).toHaveLength(0);
  });

  test("does not start when the settings contain an unknown key", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    const host = startEmbeddedHeadlessHost({
      broker,
      persisted: {
        daemon: {
          browserTools: {
            headlessHost: {
              enabled: true,
              deniedOrigin: ["https://owner.example.com"],
            },
          },
        },
      },
      logger,
      spawn: spawner.spawn,
    });

    expect(broker.getRegisteredClientCount()).toBe(0);
    await host.stop();
    expect(spawner.spawned).toHaveLength(0);
  });

  test("does not start when a setting has the wrong type", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    const host = startEmbeddedHeadlessHost({
      broker,
      persisted: {
        daemon: {
          browserTools: {
            headlessHost: { enabled: true, deniedOrigins: "https://owner.example.com" },
          },
        },
      },
      logger,
      spawn: spawner.spawn,
    });

    expect(broker.getRegisteredClientCount()).toBe(0);
    await host.stop();
    expect(spawner.spawned).toHaveLength(0);
  });

  test("starts the browser process on the first request with normalized denied hosts", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    startEmbeddedHeadlessHost({
      broker,
      persisted: {
        daemon: {
          browserTools: {
            headlessHost: { enabled: true, deniedOrigins: ["https://Owner.Example.com/settings"] },
          },
        },
      },
      logger,
      spawn: spawner.spawn,
    });

    expect(broker.getRegisteredClientCount()).toBe(1);
    expect(spawner.spawned).toHaveLength(0);

    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(spawner.spawned).toEqual([{ deniedHosts: ["owner.example.com"] }]);
    expect(spawner.processes[0]?.requests).toHaveLength(2);
  });

  test("fails fast during crash backoff and restarts afterwards", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    const clock = createClock();
    startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      spawn: spawner.spawn,
      now: clock.now,
    });
    await listTabs(broker);

    spawner.processes[0]?.crash();
    await settle();
    await expect(listTabs(broker)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_no_host",
        retryable: true,
        message: expect.stringContaining("restarting"),
      },
    });
    expect(spawner.spawned).toHaveLength(1);

    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(spawner.spawned).toHaveLength(2);

    // A second quick crash doubles the backoff.
    spawner.processes[1]?.crash();
    await settle();
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: false });
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(spawner.spawned).toHaveLength(3);
  });

  test("failed readiness keeps increasing backoff even after long startup", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner(2);
    const clock = createClock();
    startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      spawn: (options) => {
        clock.advance(60_000);
        return spawner.spawn(options);
      },
      now: clock.now,
    });

    await expect(listTabs(broker)).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", message: "Chromium is not installed" },
    });
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", message: "Chromium is not installed" },
    });
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("restarting") },
    });
    expect(spawner.spawned).toHaveLength(2);
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
  });

  test("unregisters and stops the browser process with the daemon", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    const host = startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      spawn: spawner.spawn,
    });
    await listTabs(broker);

    await host.stop();
    expect(broker.getRegisteredClientCount()).toBe(0);
    expect(spawner.processes[0]?.closed).toBe(true);
  });
});

// A launcher adapter with real event/stream semantics and no OS process.
class FakeBrowserLaunch extends ChildProcess {
  public override connected = true;
  public override stderr = new PassThrough();
  public readonly signals: Array<NodeJS.Signals | number> = [];
  public override send: ChildProcess["send"] = (raw) => {
    const message = parseHeadlessHostParentMessage(raw);
    if (!message) throw new Error("Invalid browser request");
    queueMicrotask(() =>
      this.emit("message", {
        type: "response",
        payload: {
          requestId: message.request.requestId,
          ok: true,
          result: {
            command: "new_tab",
            browserId: "00000000-0000-4000-8000-000000000001",
            workspaceId: "wks_a",
            url: "https://example.com",
          },
        },
      }),
    );
    return true;
  };

  public override kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

test.each([
  "exits immediately",
  "never becomes ready",
  "reports a fatal launch error",
  "reports a fatal error without browser logs",
])("new_tab reports launch diagnostics when the browser %s", async (scenario) => {
  const child = new FakeBrowserLaunch();
  const logs: string[] = [];
  const broker = new BrowserToolsBroker({ defaultTimeoutMs: 1_000 });
  const host = startEmbeddedHeadlessHost({
    broker,
    persisted: ENABLED,
    logger: pino({ level: "info" }, { write: (line) => logs.push(line) }),
    spawn: (options) =>
      spawnHeadlessHostProcess({
        options,
        readyTimeoutMs: 25,
        startupTimeoutMs: 100,
        launch: () => {
          queueMicrotask(() => {
            child.stderr.write("old output\n".repeat(1_000));
            child.stderr.write("[err] ZygoteMain: initializing 0 fork delegates\n");
            child.stderr.write("[err] FATAL: zygote startup failed\n");
            if (scenario === "exits immediately") child.emit("close", null, "SIGABRT");
            if (scenario === "reports a fatal error without browser logs") {
              child.emit("message", { type: "fatal", message: "Launch failed before readiness" });
            }
            if (scenario === "reports a fatal launch error")
              child.emit("message", {
                type: "fatal",
                message:
                  "Browser logs:\n" +
                  "startup output\n".repeat(250) +
                  "[err] FATAL: zygote startup failed\nprocess did exit: signal=SIGABRT",
              });
          });
          return child;
        },
      }),
  });
  try {
    const result = await broker.execute({
      workspaceId: "wks_a",
      command: { command: "new_tab", args: { url: "https://example.com" } },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
    if (result.ok) throw new Error("Expected browser launch failure");
    expect(result.error.message).toContain("FATAL: zygote startup failed");
    expect(result.error.message.length).toBeLessThan(4_500);
    if (scenario === "exits immediately") {
      expect(result.error.message).toContain("code: null, signal: SIGABRT");
    } else if (scenario === "never becomes ready") {
      expect(result.error.message).toContain("did not become ready within 25ms");
      expect(child.signals).toEqual([]);
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect(child.signals).toEqual(["SIGTERM"]);
    } else {
      expect(result.error.message.length).toBeLessThanOrEqual(4_000);
      expect(result.error.message.match(/FATAL: zygote startup failed/g)).toHaveLength(1);
    }
    expect(
      logs.some(
        (line) =>
          line.includes("Headless browser request failed") &&
          line.includes("FATAL: zygote startup failed"),
      ),
    ).toBe(true);
  } finally {
    await host.stop();
  }
});

test("a slow launch remains alive and serves the next new_tab request", async () => {
  const child = new FakeBrowserLaunch();
  let launches = 0;
  const broker = new BrowserToolsBroker({ defaultTimeoutMs: 1_000 });
  const host = startEmbeddedHeadlessHost({
    broker,
    persisted: ENABLED,
    logger,
    spawn: (options) =>
      spawnHeadlessHostProcess({
        options,
        readyTimeoutMs: 25,
        startupTimeoutMs: 1_000,
        launch: () => {
          launches += 1;
          return child;
        },
      }),
  });
  function newTab() {
    return broker.execute({
      workspaceId: "wks_a",
      command: { command: "new_tab", args: { url: "https://example.com" } },
    });
  }
  try {
    await expect(newTab()).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host" },
    });
    expect(child.signals).toEqual([]);
    child.emit("message", { type: "ready" });
    await expect(newTab()).resolves.toMatchObject({ ok: true, result: { command: "new_tab" } });
    expect(launches).toBe(1);
    expect(child.signals).toEqual([]);
  } finally {
    await host.stop();
  }
});
