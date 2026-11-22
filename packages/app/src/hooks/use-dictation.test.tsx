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

const audioSource: { config: DictationAudioSourceConfig | null } = { config: null };

vi.mock("@/hooks/use-dictation-audio-source", () => ({
  useDictationAudioSource: (config: DictationAudioSourceConfig) => {
    audioSource.config = config;
    return {
      start: async () => undefined,
      stop: async () => undefined,
      volume: 0,
      isPaused: false,
    };
  },
}));

type ConnectionListener = (state: { status: string }) => void;

class FakeClient {
  isConnected = true;
  failStarts = false;
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
    return { dictationId, text: "hello world" };
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

function renderDictation(client: FakeClient, store: DictationRecordingStore) {
  const onTranscript = vi.fn();
  const hook = renderHook(() =>
    useDictation({
      client: client as unknown as UseDictationOptions["client"],
      onTranscript,
      recordingScope: "host:agent",
      recordingStore: store,
    }),
  );
  return { ...hook, onTranscript };
}

describe("useDictation keeps recordings until a transcript is confirmed", () => {
  beforeEach(() => {
    audioSource.config = null;
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
});
