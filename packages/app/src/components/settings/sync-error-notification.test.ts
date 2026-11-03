import { describe, expect, it, vi } from "vitest";
import { reportSyncError } from "./sync-error-notification";
describe("shared settings error episodes", () => {
  it("debounces six panes into one toast and allows another after recovery", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    for (let i = 0; i < 6; i++) reportSyncError("installation", new Error("offline"), notify);
    vi.advanceTimersByTime(1200);
    expect(notify).toHaveBeenCalledTimes(1);
    reportSyncError("installation", new Error("still offline"), notify);
    vi.advanceTimersByTime(5000);
    expect(notify).toHaveBeenCalledTimes(1);
    reportSyncError("installation", null, notify);
    reportSyncError("installation", new Error("offline again"), notify);
    vi.advanceTimersByTime(1200);
    expect(notify).toHaveBeenCalledTimes(2);
    reportSyncError("installation", null, notify);
    vi.useRealTimers();
  });
});
