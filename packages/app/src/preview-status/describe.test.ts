import type { TFunction } from "i18next";
import type { WorkspaceScriptPreview } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { describePreview } from "./describe";
import { runningPreviewListLabel } from "./use-preview-description";

// Keys, not copy: the wording is the owner's to change. These pin the truthfulness rules.
const t = ((key: string) => key) as unknown as TFunction;
const now = new Date(2026, 10, 23, 12, 0);
const at = (minutesFromNow: number) =>
  new Date(now.getTime() + minutesFromNow * 60_000).toISOString();
const describeKey = (preview: WorkspaceScriptPreview) => {
  const result = describePreview(preview, now, "en-US", t);
  return result && { line: result.line, action: result.action };
};

describe("describePreview", () => {
  it.each<[string, WorkspaceScriptPreview, { line: string; action: string | null } | null]>([
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
    ["a state this app does not know shows nothing", { state: "paused" }, null],
  ])("%s", (_name, preview, expected) => {
    expect(describeKey(preview)).toEqual(expected);
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
  it("an old report puts its last known line under the name, not beside it", () => {
    const preview: WorkspaceScriptPreview = { state: "ready", stale: true, checkedAt: at(-30) };
    const description = describePreview(preview, now, "en-US", t);
    expect(runningPreviewListLabel({ ...script, preview }, description)).toEqual({
      description: "previewStatus.stale.running.today",
    });
  });
});
