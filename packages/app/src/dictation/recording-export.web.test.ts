// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDictationExport, shareDictationExport } from "./recording-export.web";
import { DICTATION_PCM_FORMAT } from "./recording-wav";

const segment = Buffer.from([1, 0, 2, 0]).toString("base64");

describe("saving dictation audio on the web", () => {
  afterEach(() => {
    Object.assign(navigator, { share: undefined, canShare: undefined });
  });

  it("shares a prepared WAV inside the press and never reports a refused share as saved", async () => {
    const prepared = await prepareDictationExport([segment, segment], 0, DICTATION_PCM_FORMAT);
    expect(prepared.file.type).toBe("audio/wav");
    expect(prepared.file.size).toBe(44 + 8);

    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { share, canShare: () => true });
    const shared = shareDictationExport(prepared);
    // share() ran synchronously within the press, before any await could expire the gesture.
    expect(share).toHaveBeenCalledTimes(1);
    await expect(shared).resolves.toBe("shared");

    const refused = Object.assign(new Error("gesture expired"), { name: "NotAllowedError" });
    Object.assign(navigator, { share: vi.fn(async () => Promise.reject(refused)) });
    await expect(shareDictationExport(prepared)).rejects.toThrow("gesture expired");

    await expect(prepareDictationExport([segment], 0, "audio/webm")).rejects.toThrow(
      "Cannot save dictation audio",
    );
  });
});
