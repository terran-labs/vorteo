import type { TFunction } from "i18next";
import type { WorkspaceScriptPreview } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { describePreview, previewBadge } from "./describe";
import { previewRequestInFlight, runningPreviewListLabel } from "./use-preview-description";

// Keys, not copy: the wording is the owner's to change. These pin the truthfulness rules.
const t = ((key: string) => key) as unknown as TFunction;
const now = new Date(2026, 10, 23, 12, 0);
const at = (minutesFromNow: number) =>
  new Date(now.getTime() + minutesFromNow * 60_000).toISOString();
const describeKey = (preview: WorkspaceScriptPreview, lifecycle?: "running" | "stopped") => {
  const result = describePreview(preview, now, "en-US", t, lifecycle);
  return result && { line: result.line, action: result.action };
};

describe("describePreview", () => {
  it.each<
    [
      string,
      WorkspaceScriptPreview,
      { line: string; action: string | null } | null,
      ("running" | "stopped")?,
    ]
  >([
    [
      "a running preview ignores an old failed restart",
      { state: "ready", checkedAt: at(-1), restart: { status: "failed", error: "x", at: at(-5) } },
      { line: "previewStatus.line.ready", action: null },
    ],
    [
      "a running preview ignores an unconfirmed restart",
      { state: "ready", restart: { status: "unconfirmed", at: at(-1) } },
      { line: "previewStatus.line.ready", action: null },
    ],
    [
      "an unconfirmed restart newer than the last check can be tried again",
      { state: "stopped", checkedAt: at(-5), restart: { status: "unconfirmed", at: at(-1) } },
      { line: "previewStatus.line.unconfirmed", action: "retry" },
    ],
    [
      "a check after a failed restart shows the broker's state",
      {
        state: "stopped",
        stoppedAt: at(-30),
        checkedAt: at(-1),
        restart: { status: "failed", error: "x", at: at(-5) },
      },
      { line: "previewStatus.line.stopped.today", action: "start" },
    ],
    [
      "a broker message with a link is not shown",
      { state: "stopped", restart: { status: "failed", error: "see https://x.test", at: at(-1) } },
      { line: "previewStatus.line.restartFailedNoDetail", action: "retry" },
    ],
    [
      "a restart is named only with its recorded time",
      { state: "stopped", stopReason: "daemon_restart", stoppedAt: at(-30) },
      { line: "previewStatus.line.stopped.today", action: "start" },
    ],
    [
      "a recorded restart time names the restart",
      { state: "stopped", stopReason: "daemon_restart", stoppedAt: at(-30), restartedAt: at(-31) },
      { line: "previewStatus.line.stoppedByRestart.today", action: "start" },
    ],
    [
      "a future time from clock skew is never today",
      { state: "stopped", stopReason: "exited", stoppedAt: at(90) },
      { line: "previewStatus.line.stopped.date", action: "start" },
    ],
    [
      "a stale running preview says only what was last known",
      { state: "ready", stale: true, checkedAt: at(-1440) },
      { line: "previewStatus.stale.running.yesterday", action: null },
    ],
    [
      "an archived workspace offers no start",
      { state: "stopped", stopReason: "workspace_unavailable", stoppedAt: at(-5) },
      { line: "previewStatus.line.unavailable", action: null },
    ],
    [
      "why a preview cannot start does not go stale",
      { state: "stopped", stale: true, stopReason: "workspace_unavailable", stoppedAt: at(-60) },
      { line: "previewStatus.line.unavailable", action: null },
    ],
    [
      "an unconfirmed restart of a preview that is not responding can be tried again",
      {
        state: "not_responding",
        checkedAt: at(-5),
        restart: { status: "unconfirmed", at: at(-1) },
      },
      { line: "previewStatus.line.unconfirmed", action: "retry" },
    ],
    [
      "a stop in flight shows on a running preview until the broker reports it stopped",
      { state: "ready", restart: { status: "stopping", at: at(-1) } },
      { line: "previewStatus.line.stopping", action: null },
    ],
    [
      "a stopped preview no longer shows its finished stop",
      { state: "stopped", stoppedAt: at(-1), restart: { status: "stopping", at: at(-2) } },
      { line: "previewStatus.line.stopped.today", action: "start" },
    ],
    [
      "a failed stop reads as a stop on a preview that is still running",
      { state: "ready", restart: { status: "failed", error: "No", at: at(-1), mode: "stop" } },
      { line: "previewStatus.line.stopFailed", action: "stop" },
      "running",
    ],
    [
      "a failed stop without a plain message still reads as a stop",
      {
        state: "not_responding",
        restart: { status: "failed", error: "see https://x.test", at: at(-1), mode: "stop" },
      },
      { line: "previewStatus.line.stopFailedNoDetail", action: "stop" },
      "running",
    ],
    [
      "an unconfirmed stop reads as a stop",
      { state: "ready", restart: { status: "unconfirmed", at: at(-1), mode: "stop" } },
      { line: "previewStatus.line.stopUnconfirmed", action: "stop" },
      "running",
    ],
    [
      "a check after a failed stop shows the broker's state",
      {
        state: "ready",
        checkedAt: at(-1),
        restart: { status: "failed", error: "No", at: at(-5), mode: "stop" },
      },
      { line: "previewStatus.line.ready", action: null },
      "running",
    ],
    [
      "a failed stop gives way once the preview and its server have stopped",
      {
        state: "stopped",
        stoppedAt: at(-1),
        restart: { status: "failed", error: "No", at: at(-2), mode: "stop" },
      },
      { line: "previewStatus.line.stopped.today", action: "start" },
      "stopped",
    ],
    [
      "a withdrawn link whose server still runs never reads as stopped",
      { state: "stopped", stopReason: "stopped", stoppedAt: at(-5) },
      { line: "previewStatus.line.linkWithdrawn", action: "stop" },
      "running",
    ],
    [
      "a stale withdrawn link on a running server states both knowns in one line",
      { state: "stopped", stale: true, stoppedAt: at(-30), checkedAt: at(-20) },
      { line: "previewStatus.stale.linkWithdrawn.today", action: "stop" },
      "running",
    ],
    [
      "a stale withdrawn link with no check time still says the server is running",
      { state: "stopped", stale: true, stoppedAt: at(-30) },
      { line: "previewStatus.stale.linkWithdrawnUnchecked", action: "stop" },
      "running",
    ],
    ["a state this app does not know shows nothing", { state: "paused" }, null],
  ])("%s", (_name, preview, expected, lifecycle) => {
    expect(describeKey(preview, lifecycle)).toEqual(expected);
  });
});

describe("runningPreviewListLabel", () => {
  const script = {
    scriptName: "web",
    type: "service" as const,
    hostname: "web",
    port: 3000,
    lifecycle: "running" as const,
    health: null,
    proxyUrl: null,
    exitCode: null,
    terminalId: "t",
  };
  it("a preview not responding reads so even when a newer failed restart offers try again", () => {
    const preview: WorkspaceScriptPreview = {
      state: "not_responding",
      checkedAt: at(-5),
      restart: { status: "failed", error: "x", at: at(-1) },
    };
    const description = describePreview(preview, now, "en-US", t);
    expect(description?.action).toBe("retry");
    expect(runningPreviewListLabel({ ...script, preview }, description)).toEqual({
      valueKey: "previewStatus.short.notResponding",
    });
  });
  it("a withdrawn link puts its line under the name, never a plain running label", () => {
    const preview: WorkspaceScriptPreview = { state: "stopped", stoppedAt: at(-5) };
    const description = describePreview(preview, now, "en-US", t, "running");
    expect(runningPreviewListLabel({ ...script, preview }, description)).toEqual({
      description: "previewStatus.line.linkWithdrawn",
    });
  });
  it.each<[string, WorkspaceScriptPreview]>([
    [
      "a stop in flight",
      { state: "ready", restart: { status: "stopping", at: at(-1), mode: "stop" } },
    ],
    ["a failed stop", { state: "ready", restart: { status: "failed", at: at(-1), mode: "stop" } }],
    [
      "an unconfirmed stop",
      { state: "ready", restart: { status: "unconfirmed", at: at(-1), mode: "stop" } },
    ],
  ])("%s puts its line under the name, never a plain running label", (_name, preview) => {
    const description = describePreview(preview, now, "en-US", t, "running");
    expect(runningPreviewListLabel({ ...script, preview }, description)).toEqual({
      description: description?.line,
    });
  });
  it("an old report puts its last known line under the name, not beside it", () => {
    const preview: WorkspaceScriptPreview = { state: "ready", stale: true, checkedAt: at(-30) };
    const description = describePreview(preview, now, "en-US", t);
    expect(runningPreviewListLabel({ ...script, preview }, description)).toEqual({
      description: "previewStatus.stale.running.today",
    });
  });
});

describe("previewBadge", () => {
  it.each<[string, WorkspaceScriptPreview, ("running" | "stopped") | undefined, string | null]>([
    ["a ready preview has no badge", { state: "ready" }, "running", null],
    ["a stopped preview", { state: "stopped", stoppedAt: at(-5) }, "stopped", "stopped"],
    // An old report never reads as current: its badge says only "Last known", in words.
    ["a stale ready preview", { state: "ready", stale: true }, "running", "lastKnown"],
    ["a stale stopped preview", { state: "stopped", stale: true }, "stopped", "lastKnown"],
    ["a stale starting preview", { state: "starting", stale: true }, "stopped", "lastKnown"],
    [
      "a stale preview not responding",
      { state: "not_responding", stale: true },
      "running",
      "lastKnown",
    ],
    ["a stale withdrawn link", { state: "stopped", stale: true }, "running", "lastKnown"],
    [
      "an archived workspace does not go stale",
      { state: "stopped", stale: true, stopReason: "workspace_unavailable" },
      "stopped",
      "unavailable",
    ],
    [
      "the daemon's own outcome stays current beside a stale report",
      { state: "ready", stale: true, restart: { status: "failed", at: at(-1), mode: "stop" } },
      "running",
      "didntStop",
    ],
    ["a link that needs repair", { state: "stopped", needsReview: true }, "stopped", "needsRepair"],
    [
      "a failed start",
      { state: "stopped", restart: { status: "failed", at: at(-1) } },
      "stopped",
      "didntStart",
    ],
    [
      "an unconfirmed start",
      { state: "stopped", restart: { status: "unconfirmed", at: at(-1) } },
      "stopped",
      "unconfirmed",
    ],
    [
      "a failed stop",
      { state: "ready", restart: { status: "failed", at: at(-1), mode: "stop" } },
      "running",
      "didntStop",
    ],
    [
      "a stop in flight",
      { state: "ready", restart: { status: "stopping", at: at(-1) } },
      "running",
      "stopping",
    ],
    ["a withdrawn link on a running server", { state: "stopped" }, "running", "linkWithdrawn"],
    [
      "an unconfirmed stop claims nothing either",
      { state: "ready", restart: { status: "unconfirmed", at: at(-1), mode: "stop" } },
      "running",
      "unconfirmed",
    ],
    ["a state this app does not know", { state: "paused" }, "running", null],
  ])("%s", (_name, preview, lifecycle, key) => {
    expect(previewBadge(preview, lifecycle)?.key ?? null).toBe(key);
  });
});

describe("previewRequestInFlight", () => {
  it.each<[string, WorkspaceScriptPreview | undefined, boolean]>([
    [
      "a start the broker is still working on",
      { state: "starting", restart: { status: "starting", at: at(-1) } },
      true,
    ],
    [
      "a stop the broker is still working on",
      { state: "ready", restart: { status: "stopping", at: at(-1), mode: "stop" } },
      true,
    ],
    [
      "a finished, failed stop",
      { state: "ready", restart: { status: "failed", at: at(-1), mode: "stop" } },
      false,
    ],
    ["no request", { state: "ready" }, false],
    ["not a managed preview", undefined, false],
  ])("%s", (_name, preview, expected) => {
    // Stop and Restart stay disabled while any request for the preview is in flight.
    expect(previewRequestInFlight(preview)).toBe(expected);
  });
});

describe("broker messages end as sentences", () => {
  it.each([
    ["No", "No."],
    ["Done.", "Done."],
    ["Refused, try later", "Refused, try later."],
  ])("%s", (error, expected) => {
    const params: Record<string, unknown>[] = [];
    const recording = ((key: string, options?: Record<string, unknown>) => {
      if (options) params.push(options);
      return key;
    }) as unknown as TFunction;
    for (const mode of ["start", "stop"]) {
      params.length = 0;
      // A failed start shows on a stopped preview, a failed stop on a running one.
      const stop = mode === "stop";
      describePreview(
        {
          state: stop ? "ready" : "stopped",
          restart: { status: "failed", error, at: at(-1), mode },
        },
        now,
        "en-US",
        recording,
        stop ? "running" : "stopped",
      );
      expect(params[0]?.error).toBe(expected);
    }
  });
});
