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
        for (const segment of typeof tail === "string" ? [tail] : (tail ?? [])) {
          audioSource.config?.onPcmSegment(segment);
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

function renderDictation(client: FakeClient, store: DictationRecordingStore | null) {
  const onTranscript = vi.fn();
  const hook = renderHook(
    ({ scope }: { scope: string }) =>
      useDictation({
        client: client as unknown as UseDictationOptions["client"],
        onTranscript,
        recordingScope: scope,
        recordingStore: store,
      }),
    { initialProps: { scope: "host:agent" } },
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

  it("does not carry one thread's unsent audio into another thread's composer", async () => {
    const client = new FakeClient();
    const store = new DictationRecordingStore(new MemoryDictationRecordingBackend());
    const { result, rerender, onTranscript } = renderDictation(client, store);

    await recordSegments(result, ["a0", "a1"]);
    await act(() => result.current.cancelDictation());
    expect(result.current.status).toBe("failed");

    rerender({ scope: "host:other" });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    const startsBefore = client.starts.length;
    await act(() => result.current.retryFailedDictation());
    expect(client.starts).toHaveLength(startsBefore);

    rerender({ scope: "host:agent" });
    await waitFor(() => expect(result.current.status).toBe("failed"));
    await act(() => result.current.retryFailedDictation());
    expect(client.chunksFor(client.starts.at(-1))).toEqual(["a0", "a1"]);
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("routes audio that arrives after a thread switch to the thread it was recorded in", async () => {
    const client = new FakeClient();
    const backend = new MemoryDictationRecordingBackend();
    const store = new DictationRecordingStore(backend);
    const { result, rerender, onTranscript } = renderDictation(client, store);

    await recordSegments(result, ["a0"]);
    audioSource.tailOnStop = "a-tail";
    rerender({ scope: "host:other" });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await act(async () => {
      await store.flush();
    });

    // Thread B starts its own dictation; none of A's audio may reach it.
    await recordSegments(result, ["b0"]);
    await act(() => result.current.confirmDictation());
    const bStream = client.finishes.at(-1)!.dictationId;
    expect(client.chunksFor(bStream)).toEqual(["b0"]);

    rerender({ scope: "host:agent" });
    await waitFor(() => expect(result.current.status).toBe("failed"));
    await store.flush();
    const aRecording = [...backend.recordings.values()].find((r) => r.scope === "host:agent")!;
    expect(backend.segments.get(aRecording.id)).toEqual(["a0", "a-tail"]);

    await act(() => result.current.retryFailedDictation());
    expect(client.chunksFor(client.starts.at(-1))).toEqual(["a0", "a-tail"]);
    expect(onTranscript).toHaveBeenCalledTimes(2);

    // Without device storage, memory is the only copy: a thread left before any audio arrived,
    // as in MediaRecorder fallback mode, keeps the whole recording delivered at stop.
    const memoryOnly = renderDictation(new FakeClient(), null);
    await act(() => memoryOnly.result.current.startDictation());
    audioSource.tailOnStop = ["m0", "m1", "m2"];
    memoryOnly.rerender({ scope: "host:other" });
    await waitFor(() => expect(memoryOnly.result.current.status).toBe("idle"));
    await act(async () => {
      await Promise.resolve();
    });
    memoryOnly.rerender({ scope: "host:agent" });
    await waitFor(() => expect(memoryOnly.result.current.status).toBe("failed"));
    await act(() => memoryOnly.result.current.retryFailedDictation());
    expect(memoryOnly.onTranscript).toHaveBeenCalledWith("hello world", expect.anything());
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

  it("keeps a just-parked thread whole while its late audio arrives, even with full memory", async () => {
    const client = new FakeClient();
    const backend = new MemoryDictationRecordingBackend();
    const store = new DictationRecordingStore(backend, { retryDelayMs: 0 });
    const { result, rerender } = renderDictation(client, store);

    // Three threads whose device copies are incomplete, so they must stay parked in memory.
    for (const scope of ["t1", "t2", "t3"]) {
      rerender({ scope });
      await waitFor(() => expect(result.current.status).toBe("idle"));
      backend.failNextSegmentWrites = 3;
      await recordSegments(result, [`${scope}-0`]);
      await act(() => result.current.cancelDictation());
      await act(async () => {
        await store.flush();
      });
    }

    rerender({ scope: "t4" });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await recordSegments(result, ["t4-0", "t4-1"]);
    audioSource.tailOnStop = "t4-tail";
    rerender({ scope: "t5" });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await act(async () => {
      await store.flush();
    });

    rerender({ scope: "t4" });
    await waitFor(() => expect(result.current.status).toBe("failed"));
    await act(() => result.current.retryFailedDictation());
    expect(client.chunksFor(client.starts.at(-1))).toEqual(["t4-0", "t4-1", "t4-tail"]);
  });

  it("does not wipe a returning thread's late audio when the microphone is pressed during its stop", async () => {
    for (const withStore of [false, true]) {
      const backend = new MemoryDictationRecordingBackend();
      const store = withStore ? new DictationRecordingStore(backend) : null;
      const client = new FakeClient();
      const { result, rerender, onTranscript, unmount } = renderDictation(client, store);

      // MediaRecorder-style: the whole recording arrives 40 ms after stop.
      await act(() => result.current.startDictation());
      audioSource.tailOnStop = ["m0", "m1", "m2"];
      audioSource.stopDelayMs = 40;
      rerender({ scope: "host:other" });
      rerender({ scope: "host:agent" });
      await act(() => result.current.startDictation());

      expect(result.current.status).toBe("failed");
      await act(() => result.current.retryFailedDictation());
      expect(client.chunksFor(client.starts.at(-1))).toEqual(["m0", "m1", "m2"]);
      expect(onTranscript).toHaveBeenCalledWith("hello world", expect.anything());
      unmount();
      audioSource.stopDelayMs = 0;
    }
  });
});
