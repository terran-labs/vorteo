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
  /** Models an AudioContext close that never settles, as on some iOS builds. */
  static hangClose = false;
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
    if (FakeAudioContext.hangClose) {
      await new Promise(() => undefined);
    }
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

  it("waits for an in-flight stop before opening the microphone again", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const calls: string[] = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          calls.push("open");
          return { getTracks: () => [{ stop: vi.fn() }] };
        },
      },
    });
    const onPcmSegment = vi.fn(() => calls.push("tail"));
    const { result } = renderHook(() => useDictationAudioSource({ onPcmSegment }));

    await act(() => result.current.start());
    act(() => {
      FakeAudioContext.processor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(8000).fill(0.1) },
      });
    });
    await act(() => Promise.all([result.current.stop(), result.current.start()]));

    // The second capture opens only after the first delivered its last audio.
    expect(calls).toEqual(["open", "tail", "open"]);
  });

  it("releases a microphone granted after the composer closed during the permission prompt", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const track = { stop: vi.fn() };
    let grant: (stream: unknown) => void = () => undefined;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    const { result, unmount } = renderHook(() =>
      useDictationAudioSource({ onPcmSegment: vi.fn() }),
    );

    const starting = result.current.start();
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    grant({ getTracks: () => [track] });
    await expect(starting).rejects.toThrow("closed");
    expect(track.stop).toHaveBeenCalled();
  });

  it("waits for another instance's stop, so a remounted composer never overlaps the old capture", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const calls: string[] = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          calls.push("open");
          return { getTracks: () => [{ stop: vi.fn() }] };
        },
      },
    });
    const closing = renderHook(() =>
      useDictationAudioSource({ onPcmSegment: () => calls.push("old tail") }),
    );
    await act(() => closing.result.current.start());
    act(() => {
      FakeAudioContext.processor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(8000).fill(0.1) },
      });
    });
    const reopened = renderHook(() => useDictationAudioSource({ onPcmSegment: vi.fn() }));

    await act(() => Promise.all([closing.result.current.stop(), reopened.result.current.start()]));
    expect(calls).toEqual(["open", "old tail", "open"]);
  });

  it("starts within a bounded wait when another instance's stop never settles", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    const stuck = renderHook(() => useDictationAudioSource({ onPcmSegment: vi.fn() }));
    await act(() => stuck.result.current.start());
    FakeAudioContext.hangClose = true;
    try {
      void stuck.result.current.stop();
      const next = renderHook(() => useDictationAudioSource({ onPcmSegment: vi.fn() }));
      const startedAt = Date.now();
      await act(() => next.result.current.start());
      // It waited for the stuck stop, then went ahead instead of blocking every later start.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
    } finally {
      FakeAudioContext.hangClose = false;
    }
  }, 15_000);
});
