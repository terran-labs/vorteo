import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { admitPreviewRestart, PreviewBrokerRestarter } from "./preview-broker-restart.js";
import {
  previewBrokerIsStale,
  projectWorkspaceScriptPreview,
  readPreviewBrokerStatus,
  type PreviewBrokerService,
} from "./preview-broker-status.js";

const broker: PreviewBrokerService = {
  workspaceId: "wks_a",
  service: "web",
  desired: "stopped",
  status: "failed",
  stoppedAt: 1_000,
};
const channels: string[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) rmSync(channel, { recursive: true, force: true });
});

function makeChannel(): string {
  const directory = mkdtempSync(join(tmpdir(), "preview-channel-"));
  channels.push(directory);
  for (const name of ["inbox", "receipts"]) mkdirSync(join(directory, name));
  writeFileSync(join(directory, "installed.json"), "{}");
  return directory;
}

describe("preview restart admission", () => {
  const restarter = { inFlight: () => false, atCapacity: () => false };
  const allowed = {
    credential: "password" as const,
    restarter,
    brokerAvailable: true,
    workspace: { archivedAt: null },
    hasReservation: true,
    broker,
    workspaceId: "wks_a",
    scriptName: "web",
    requester: "session-a",
  };

  test("admits only a password session, for a reserved preview that needs no review", () => {
    expect(admitPreviewRestart(allowed)).toBeNull();
    // The local credential is readable by any process of the daemon's user, agents included.
    for (const credential of ["local", "service", "plugin", "open", null] as const) {
      expect(admitPreviewRestart({ ...allowed, credential })?.code).toBe("owner_app_only");
    }
    expect(admitPreviewRestart({ ...allowed, workspace: { archivedAt: "2026-11-01" } })?.code).toBe(
      "workspace_unavailable",
    );
    expect(admitPreviewRestart({ ...allowed, hasReservation: false })?.code).toBe("no_reservation");
    expect(
      admitPreviewRestart({ ...allowed, broker: { ...broker, needsReview: true } })?.code,
    ).toBe("needs_review");
    expect(admitPreviewRestart({ ...allowed, broker: null })?.code).toBe("broker_unavailable");
    expect(admitPreviewRestart({ ...allowed, brokerAvailable: false })?.code).toBe(
      "broker_unavailable",
    );
    // One restart per preview, and a few in all, so restarts cannot flood the broker.
    expect(
      admitPreviewRestart({ ...allowed, restarter: { ...restarter, inFlight: () => true } })?.code,
    ).toBe("busy");
    expect(
      admitPreviewRestart({ ...allowed, restarter: { ...restarter, atCapacity: () => true } })
        ?.code,
    ).toBe("busy");
  });
});

describe("preview broker restarter", () => {
  test("writes one valid broker request and reports the broker's failure", async () => {
    const directory = makeChannel();
    const onChange = vi.fn();
    const restarter = new PreviewBrokerRestarter({
      channel: directory,
      onChange,
      logger: pino({ level: "silent" }),
      pollMs: 5,
    });
    await restarter.submit("wks_a", "web", "start", "session-a");
    expect(restarter.inFlight("wks_a", "web")).toBe(true);
    await expect(restarter.submit("wks_a", "web", "start", "session-a")).rejects.toThrow(
      "already running",
    );
    // One session holds at most two of the three slots, so another session keeps one.
    await restarter.submit("wks_a", "api", "start", "session-a");
    expect(restarter.atCapacity("session-a")).toBe(true);
    expect(restarter.atCapacity("session-b")).toBe(false);

    const requests = readdirSync(join(directory, "inbox")).map((file) =>
      JSON.parse(readFileSync(join(directory, "inbox", file), "utf8")),
    );
    const request = requests.find((entry) => entry.service === "web");
    // Exactly the fields the broker's validate() accepts.
    expect(Object.keys(request).sort()).toEqual([
      "createdAt",
      "id",
      "operation",
      "service",
      "workspaceId",
    ]);
    expect(request).toMatchObject({ operation: "start", workspaceId: "wks_a", service: "web" });

    writeFileSync(
      join(directory, "receipts", `${request.id}.json`),
      JSON.stringify({ status: "failed", error: "Service configuration identity changed" }),
    );
    await vi.waitFor(() => expect(restarter.outcome("wks_a", "web")?.status).toBe("failed"));
    expect(restarter.outcome("wks_a", "web")?.error).toBe("Service configuration identity changed");
    expect(onChange).toHaveBeenLastCalledWith("wks_a");
    // Finish the second restart so nothing keeps polling after the test.
    const other = requests.find((entry) => entry.service === "api");
    writeFileSync(join(directory, "receipts", `${other.id}.json`), '{"status":"ready"}');
    await vi.waitFor(() => expect(restarter.outcome("wks_a", "api")).toBeNull());
  });
});

describe("preview restart limits under concurrency", () => {
  function restarterFor(directory: string) {
    return new PreviewBrokerRestarter({
      channel: directory,
      onChange: () => {},
      logger: pino({ level: "silent" }),
      pollMs: 5,
    });
  }
  async function finishAll(directory: string) {
    // Answer every request so no follow keeps polling after the test.
    for (const file of readdirSync(join(directory, "inbox"))) {
      const { id } = JSON.parse(readFileSync(join(directory, "inbox", file), "utf8"));
      writeFileSync(join(directory, "receipts", `${id}.json`), '{"status":"ready"}');
    }
  }

  test("concurrent submits cannot exceed a session's share or start one preview twice", async () => {
    const directory = makeChannel();
    const restarter = restarterFor(directory);
    const results = await Promise.allSettled(
      ["web", "api", "ui", "web"].map((service) =>
        restarter.submit("wks_a", service, "start", "session-a"),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(readdirSync(join(directory, "inbox"))).toHaveLength(2);

    const second = makeChannel();
    const other = restarterFor(second);
    const duplicates = await Promise.allSettled([
      other.submit("wks_a", "web", "start", "session-a"),
      other.submit("wks_a", "web", "start", "session-b"),
    ]);
    expect(duplicates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(readdirSync(join(second, "inbox"))).toHaveLength(1);
    await finishAll(directory);
    await finishAll(second);
    await vi.waitFor(() => expect(restarter.atCapacity("session-a")).toBe(false));
    await vi.waitFor(() => expect(other.inFlight("wks_a", "web")).toBe(false));
  });

  test("a failed inbox write gives its slot back", async () => {
    const directory = makeChannel();
    rmSync(join(directory, "inbox"), { recursive: true });
    const restarter = restarterFor(directory);
    await expect(restarter.submit("wks_a", "web", "start", "session-a")).rejects.toThrow();
    expect(restarter.inFlight("wks_a", "web")).toBe(false);
    expect(restarter.outcome("wks_a", "web")).toBeNull();
  });
});

describe("preview state projection", () => {
  test("a forged or unknown broker entry cannot add a cause or a link", () => {
    // In Dev the status file is agent-writable; only known codes and plain text pass.
    const preview = projectWorkspaceScriptPreview({
      broker: {
        ...broker,
        stopReason: "owner_asked",
        error: "Open https://example.test to fix this",
      },
      stale: false,
      lifecycle: "stopped",
      health: null,
      restart: null,
    });
    expect(preview.state).toBe("stopped");
    expect(preview.stopReason).toBeUndefined();
    expect(preview.error).toBeUndefined();
  });
});

describe("preview broker status file", () => {
  const status = (services: unknown[]) =>
    JSON.stringify({ version: 1, publishedAt: Date.now() / 1000, services });

  test("a planted FIFO, link or oversized file reads as absent without blocking", async () => {
    const directory = makeChannel();
    const fifo = join(directory, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    const link = join(directory, "link.json");
    symlinkSync("/dev/zero", link);
    const large = join(directory, "large.json");
    writeFileSync(large, status([{ workspaceId: "wks_a", service: "x".repeat(300_000) }]));
    // Each would have hung on open, read forever or loaded the whole file before.
    for (const file of [fifo, link, large]) {
      await expect(readPreviewBrokerStatus(file)).resolves.toBeNull();
    }
  });

  test("stale follows the broker, not one entry left behind by a long round-robin pass", async () => {
    const directory = makeChannel();
    const file = join(directory, "preview-status.json");
    const now = Date.now() / 1000;
    writeFileSync(
      file,
      status([
        { workspaceId: "wks_a", service: "web", desired: "running", checkedAt: now - 600 },
        { workspaceId: "wks_a", service: "api", desired: "running", checkedAt: now - 5 },
      ]),
    );
    const read = await readPreviewBrokerStatus(file);
    expect(read && previewBrokerIsStale(read, now)).toBe(false);
    expect(read && previewBrokerIsStale(read, now + 120)).toBe(true);
  });
});
