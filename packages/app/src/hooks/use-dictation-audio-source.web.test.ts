// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDictationAudioSource } from "./use-dictation-audio-source.web";

interface FakeProcessor {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
  connect: () => void;
  disconnect: () => void;
}

const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

class FakeAudioContext {
  static processor: FakeProcessor | null = null;
  sampleRate = 16000;
  destination = {};
  createMediaStreamSource() {
    return node();
  }
  createScriptProcessor(): FakeProcessor {
    const processor: FakeProcessor = { onaudioprocess: null, ...node() };
    FakeAudioContext.processor = processor;
    return processor;
  }
  createGain() {
    return { gain: { value: 1 }, ...node() };
  }
  async close() {
    // Teardown takes a moment, as in a browser; the last partial segment is emitted after it.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("web dictation audio source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits the last partial segment once when two stops overlap", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    const onPcmSegment = vi.fn();
    const { result } = renderHook(() => useDictationAudioSource({ onPcmSegment }));

    await act(() => result.current.start());
    act(() => {
      // Half a second of audio: shorter than a full segment, so it stays pending until stop.
      FakeAudioContext.processor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(8000).fill(0.1) },
      });
    });
    expect(onPcmSegment).not.toHaveBeenCalled();

    // The dictation hook's cleanup and the source's own unmount stop overlap like this.
    await act(() => Promise.all([result.current.stop(), result.current.stop()]));
    expect(onPcmSegment).toHaveBeenCalledTimes(1);

    await act(() => result.current.stop());
    expect(onPcmSegment).toHaveBeenCalledTimes(1);
  });
});
