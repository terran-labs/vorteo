// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DictationRecordingStore,
  MemoryDictationRecordingBackend,
} from "@/dictation/recording-store";
import type { DictationAudioSourceConfig } from "@/hooks/use-dictation-audio-source.types";
import { useDictation } from "./use-dictation";
import type { UseDictationOptions } from "./use-dictation.shared";

const audioSource: {
  config: DictationAudioSourceConfig | null;
  tailOnStop: string | string[] | null;
  stopDelayMs: number;
} = {
  config: null,
  tailOnStop: null,
  stopDelayMs: 0,
};

const exportCalls: Array<{ segments: readonly string[] }> = [];
const prepareControl: { calls: number; gate: Promise<void> | null } = { calls: 0, gate: null };
vi.mock("@/dictation/recording-export", () => ({
  prepareDictationExport: async (segments: readonly string[]) => {
    prepareControl.calls += 1;
    if (prepareControl.gate) {
      await prepareControl.gate;
    }
    return {
      fileName: "dictation.wav",
      segmentCount: segments.length,
      segments: [...segments],
      release: () => undefined,
    };
  },
  shareDictationExport: async (prepared: { segments: string[] }) => {
    exportCalls.push({ segments: prepared.segments });
    return "shared";
  },
}));

vi.mock("@/hooks/use-dictation-audio-source", () => ({
  useDictationAudioSource: (config: DictationAudioSourceConfig) => {
    audioSource.config = config;
    return {
      start: async () => undefined,
      // Like the web source, emit the last partial segment only after stop has awaited teardown.
      stop: async () => {
        await Promise.resolve();
        if (audioSource.stopDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, audioSource.stopDelayMs));
        }
        // An array models MediaRecorder fallback mode, which delivers the whole recording here.
        const tail = audioSource.tailOnStop;
        audioSource.tailOnStop = null;
        // Each source instance delivers to its own composer, as a real one does.
        for (const segment of typeof tail === "string" ? [tail] : (tail ?? [])) {
          config.onPcmSegment(segment);
        }
      },
      volume: 0,
      isPaused: false,
    };
  },
}));

type ConnectionListener = (state: { status: string }) => void;

class FakeClient {
  isConnected = true;
  failStarts = false;
  failFinishes = 0;
  finishText = "hello world";
  starts: string[] = [];
  chunks: Array<{ dictationId: string; seq: number; audio: string }> = [];
  finishes: Array<{ dictationId: string; finalSeq: number }> = [];
  cancels: string[] = [];
  private raw = new Set<(message: SessionOutboundMessage) => void>();
  private connection = new Set<ConnectionListener>();

  async startDictationStream(dictationId: string): Promise<void> {
    this.starts.push(dictationId);
    if (this.failStarts) {
      throw new Error("Timeout waiting for message");
    }
  }

  sendDictationStreamChunk(dictationId: string, seq: number, audio: string): void {
    this.chunks.push({ dictationId, seq, audio });
    for (const listener of this.raw) {
      listener({
        type: "dictation_stream_ack",
        payload: { dictationId, ackSeq: seq },
      } as SessionOutboundMessage);
    }
  }

  async finishDictationStream(dictationId: string, finalSeq: number) {
    this.finishes.push({ dictationId, finalSeq });
    if (this.failFinishes > 0) {
      this.failFinishes -= 1;
      throw new Error("Timeout waiting for message");
    }
    return { dictationId, text: this.finishText };
  }

  cancelDictationStream(dictationId: string): void {
    this.cancels.push(dictationId);
  }

  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void) {
    this.raw.add(handler);
    return () => this.raw.delete(handler);
  }

  subscribeConnectionStatus(listener: ConnectionListener) {
    this.connection.add(listener);
    return () => this.connection.delete(listener);
  }

  on() {
    return () => undefined;
  }

  setConnected(connected: boolean): void {
    this.isConnected = connected;
    for (const listener of this.connection) {
      listener({ status: connected ? "connected" : "disconnected" });
    }
  }

  chunksFor(dictationId: string | undefined) {
    return this.chunks.filter((chunk) => chunk.dictationId === dictationId).map((c) => c.audio);
  }
}

function renderDictation(
  client: FakeClient,
  store: DictationRecordingStore | null,
  scope = "host:agent",
) {
  const onTranscript = vi.fn();
  const hook = renderHook(() =>
    useDictation({
      client: client as unknown as UseDictationOptions["client"],
      onTranscript,
      recordingScope: scope,
      recordingStore: store,
    }),
  );
  return { ...hook, onTranscript };
}

async function recordSegments(
  result: { current: ReturnType<typeof useDictation> },
  segments: string[],
) {
  await act(() => result.current.startDictation());
  act(() => {
    for (const segment of segments) {
      audioSource.config?.onPcmSegment(segment);
    }
  });
}

describe("useDictation keeps recordings until a transcript is confirmed", () => {
  beforeEach(() => {
    audioSource.config = null;
    audioSource.tailOnStop = null;
    audioSource.stopDelayMs = 0;
  });

  it("keeps audio after a timed-out start, offers Retry, replays it and then deletes it", async () => {
    const client = new FakeClient();
    client.failStarts = true;
    const backend = new MemoryDictationRecordingBackend();
    const store = new DictationRecordingStore(backend);
    const { result, onTranscript } = renderDictation(client, store);

    await act(() => result.current.startDictation());
    expect(result.current.status).toBe("recording");
    act(() => {
      for (const segment of ["s0", "s1", "s2"]) {
        audioSource.config?.onPcmSegment(segment);
      }
    });
    await act(() => result.current.confirmDictation());

    expect(result.current.status).toBe("failed");
    // Every start that timed out is cancelled so the Host does not keep it open.
    expect(client.cancels).toEqual(expect.arrayContaining(client.starts));
    await store.flush();
    expect([...backend.segments.values()][0]).toEqual(["s0", "s1", "s2"]);

    // A new start must not wipe the unsent recording.
    await act(() => result.current.startDictation());
    expect(result.current.status).toBe("failed");

    client.failStarts = false;
    const startsBefore = client.starts.length;
    await act(() => result.current.retryFailedDictation());

    expect(client.starts.length).toBe(startsBefore + 1);
    const retryId = client.starts.at(-1);
    expect(client.chunksFor(retryId)).toEqual(["s0", "s1", "s2"]);
    expect(client.finishes.at(-1)).toEqual({ dictationId: retryId, finalSeq: 2 });
    expect(onTranscript).toHaveBeenCalledWith("hello world", expect.anything());
    expect(result.current.status).toBe("idle");
    await store.flush();
    expect(backend.recordings.size).toBe(0);
  });

  it("offers a stored recording back after a reload and resends it when the connection returns", async () => {
    const backend = new MemoryDictationRecordingBackend();
    const before = new DictationRecordingStore(backend);
    const id = before.begin("host:agent", "audio/pcm;rate=16000;bits=16")!;
    for (const segment of ["a", "b", "c", "d"]) {
      before.append(id, segment);
    }
    await before.flush();

    // The reload: a new store and a new composer over the same device storage.
    const client = new FakeClient();
    client.isConnected = false;
    const { result, onTranscript } = renderDictation(client, new DictationRecordingStore(backend));
    await waitFor(() => expect(result.current.status).toBe("failed"));

    await act(() => result.current.retryFailedDictation());
    expect(client.starts).toEqual([]);
    expect(result.current.status).toBe("failed");

    await act(async () => {
      client.setConnected(true);
    });
    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("hello world", expect.anything()),
    );
    expect(client.chunksFor(client.starts.at(-1))).toEqual(["a", "b", "c", "d"]);
    await waitFor(() => expect(backend.recordings.size).toBe(0));
  });

  it("keeps every segment when dictation is cancelled, and Retry still sends them", async () => {
    const client = new FakeClient();
    const backend = new MemoryDictationRecordingBackend();
    const store = new DictationRecordingStore(backend);
    const { result, onTranscript } = renderDictation(client, store);

    await recordSegments(result, ["c0", "c1", "c2"]);
    await act(() => result.current.cancelDictation());

    expect(result.current.status).toBe("failed");
    await store.flush();
    expect([...backend.segments.values()][0]).toEqual(["c0", "c1", "c2"]);

    await act(() => result.current.retryFailedDictation());
    expect(client.chunksFor(client.starts.at(-1))).toEqual(["c0", "c1", "c2"]);
    expect(onTranscript).toHaveBeenCalledWith("hello world", expect.anything());
    await waitFor(() => expect(backend.recordings.size).toBe(0));
  });

  it("treats an empty final transcript as a failure and keeps the audio", async () => {
    const client = new FakeClient();
    client.finishText = "   ";
    const backend = new MemoryDictationRecordingBackend();
    const store = new DictationRecordingStore(backend);
    const { result, onTranscript } = renderDictation(client, store);

    await recordSegments(result, ["e0", "e1"]);
    await act(() => result.current.confirmDictation());

    expect(result.current.status).toBe("failed");
    expect(onTranscript).not.toHaveBeenCalled();
    await store.flush();
    expect(backend.recordings.size).toBe(1);
    expect([...backend.segments.values()][0]).toEqual(["e0", "e1"]);
  });

  it("cancels the timed-out stream on the server before a Retry replays", async () => {
    const client = new FakeClient();
    client.failFinishes = 1;
    const store = new DictationRecordingStore(new MemoryDictationRecordingBackend());
    const { result } = renderDictation(client, store);

    await recordSegments(result, ["f0", "f1"]);
    await act(() => result.current.confirmDictation());
    expect(result.current.status).toBe("failed");
    const timedOut = client.finishes[0]!.dictationId;

    await act(() => result.current.retryFailedDictation());
    expect(client.cancels).toContain(timedOut);
    const retryId = client.starts.at(-1);
    expect(retryId).not.toBe(timedOut);
    expect(client.chunksFor(retryId)).toEqual(["f0", "f1"]);
  });

  it("discards a capture under five seconds when Cancel is pressed, and keeps a longer one", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      const backend = new MemoryDictationRecordingBackend();
      const store = new DictationRecordingStore(backend);
      const { result } = renderDictation(new FakeClient(), store);

      now.mockReturnValue(10_000);
      await recordSegments(result, ["short"]);
      now.mockReturnValue(14_999);
      await act(() => result.current.cancelDictation({ source: "button" }));
      expect(result.current.status).toBe("idle");
      await store.flush();
      expect(backend.recordings.size).toBe(0);

      now.mockReturnValue(20_000);
      await recordSegments(result, ["long"]);
      now.mockReturnValue(25_000);
      await act(() => result.current.cancelDictation({ source: "button" }));
      expect(result.current.status).toBe("failed");
      await store.flush();
      expect([...backend.segments.values()][0]).toEqual(["long"]);
    } finally {
      now.mockRestore();
    }
  });

  it("saves the audio without touching the stored recording, and says where the audio is", async () => {
    const backend = new MemoryDictationRecordingBackend();
    // Hold segment writes, as a slow device would, until the failed state has rendered.
    let releaseWrites: () => void = () => undefined;
    const writesHeld = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const putSegment = backend.putSegment.bind(backend);
    backend.putSegment = async (id, seq, data) => {
      await writesHeld;
      return putSegment(id, seq, data);
    };
    const store = new DictationRecordingStore(backend);
    const { result } = renderDictation(new FakeClient(), store);

    await recordSegments(result, ["s0", "s1"]);
    await act(() => result.current.cancelDictation());
    expect(result.current.status).toBe("failed");
    // Until the writes land the notice claims nothing; then it says the recording is kept.
    expect(result.current.recordingPersistence).toBe("saving");
    releaseWrites();
    await act(async () => {
      await store.flush();
    });
    expect(result.current.recordingPersistence).toBe("stored");

    exportCalls.length = 0;
    await act(() => result.current.saveFailedRecording());
    expect(exportCalls).toEqual([{ segments: ["s0", "s1"] }]);
    expect(result.current.status).toBe("failed");
    await store.flush();
    expect([...backend.segments.values()][0]).toEqual(["s0", "s1"]);

    // Without device storage the notice must not claim the audio is kept.
    const memoryOnly = renderDictation(new FakeClient(), null);
    await recordSegments(memoryOnly.result, ["m0"]);
    await act(() => memoryOnly.result.current.cancelDictation());
    expect(memoryOnly.result.current.recordingPersistence).toBe("memory-only");
  });

  it("says a recording is not saved when its writes never land", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const backend = new MemoryDictationRecordingBackend();
      // A hung IndexedDB: segment writes never complete.
      backend.putSegment = () => new Promise<void>(() => undefined);
      const store = new DictationRecordingStore(backend);
      const { result } = renderDictation(new FakeClient(), store);

      await recordSegments(result, ["h0"]);
      await act(() => result.current.cancelDictation());
      expect(result.current.recordingPersistence).toBe("saving");
      await act(async () => {
        vi.advanceTimersByTime(10_001);
      });
      expect(result.current.recordingPersistence).toBe("memory-only");
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds the file once for repeated presses and asks for a second press when it is ready", async () => {
    let finishBuild: () => void = () => undefined;
    prepareControl.calls = 0;
    prepareControl.gate = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    try {
      const store = new DictationRecordingStore(new MemoryDictationRecordingBackend());
      const { result } = renderDictation(new FakeClient(), store);
      await recordSegments(result, ["p0", "p1"]);
      await act(() => result.current.cancelDictation());
      expect(result.current.status).toBe("failed");

      // Two quick presses while the build is still running share that one build.
      exportCalls.length = 0;
      let presses: Promise<void>[] = [];
      act(() => {
        presses = [result.current.saveFailedRecording(), result.current.saveFailedRecording()];
      });
      expect(result.current.saveAudioState).toBe("preparing");
      await act(async () => {
        finishBuild();
        await Promise.all(presses);
      });
      expect(prepareControl.calls).toBe(1);
      // That press's gesture is gone, so nothing was shared; the owner presses again.
      expect(exportCalls).toEqual([]);
      expect(result.current.saveAudioState).toBe("ready");

      await act(() => result.current.saveFailedRecording());
      expect(exportCalls).toEqual([{ segments: ["p0", "p1"] }]);
      expect(prepareControl.calls).toBe(1);
    } finally {
      prepareControl.gate = null;
    }
  });

  it("offers a recording back in full after its composer closed mid-recording", async () => {
    // With a device store, and with no device storage at all (the audio lives only in memory).
    for (const backend of [new MemoryDictationRecordingBackend(), null]) {
      const store = new DictationRecordingStore(backend);
      const first = renderDictation(new FakeClient(), store);
      await recordSegments(first.result, ["r0", "r1"]);
      // Closing the composer, as a thread switch does, stops the microphone; its last audio
      // arrives after the composer is gone.
      audioSource.tailOnStop = "r-tail";
      first.unmount();

      const client = new FakeClient();
      const reopened = renderDictation(client, store);
      await waitFor(() => expect(reopened.result.current.status).toBe("failed"));
      await act(() => reopened.result.current.retryFailedDictation());
      expect(client.chunksFor(client.starts.at(-1))).toEqual(["r0", "r1", "r-tail"]);
      expect(reopened.onTranscript).toHaveBeenCalledWith("hello world", expect.anything());
      reopened.unmount();
    }
  });

  it("never shows one thread's unsent recording in another thread's composer", async () => {
    const store = new DictationRecordingStore(new MemoryDictationRecordingBackend());
    const first = renderDictation(new FakeClient(), store, "dictation:thread-a");
    await recordSegments(first.result, ["a0"]);
    await act(() => first.result.current.cancelDictation());
    first.unmount();

    const other = renderDictation(new FakeClient(), store, "dictation:thread-b");
    await act(async () => {
      await store.flush();
    });
    expect(other.result.current.status).toBe("idle");
    other.unmount();

    const back = renderDictation(new FakeClient(), store, "dictation:thread-a");
    await waitFor(() => expect(back.result.current.status).toBe("failed"));
  });
});
