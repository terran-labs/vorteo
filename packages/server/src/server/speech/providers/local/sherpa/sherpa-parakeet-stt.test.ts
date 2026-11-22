import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { SherpaOnnxParakeetSTT } from "./sherpa-parakeet-stt.js";
import type { SherpaParakeetSttConfig } from "./sherpa-parakeet-stt.js";
import type { TranscriptionResult } from "../../../speech-provider.js";
import { SherpaParakeetRealtimeTranscriptionSession } from "./sherpa-parakeet-realtime-session.js";
import {
  decodeBoundMs,
  withDecodeBound,
  type SherpaOfflineRecognizerEngine,
} from "./sherpa-offline-recognizer.js";
import { SpeechProviderError } from "../../speech-provider-error.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class TestSherpaOnnxParakeetStt extends SherpaOnnxParakeetSTT {
  public readonly calls: Array<{ audio: Buffer; format: string }> = [];
  public readonly pending: Array<ReturnType<typeof createDeferred<TranscriptionResult>>> = [];

  constructor() {
    super(
      { engine: { sampleRate: 16000 } } as unknown as SherpaParakeetSttConfig,
      pino({ level: "silent" }),
    );
  }

  override async transcribeAudio(
    audioBuffer: Buffer,
    format: string,
  ): Promise<TranscriptionResult> {
    this.calls.push({ audio: Buffer.from(audioBuffer), format });
    const deferred = createDeferred<TranscriptionResult>();
    this.pending.push(deferred);
    return deferred.promise;
  }
}

describe("SherpaOnnxParakeetSTT session", () => {
  it("snapshots segment ids and buffers before async transcription starts", async () => {
    const provider = new TestSherpaOnnxParakeetStt();
    const session = provider.createSession({
      logger: pino({ level: "silent" }),
      language: "en",
    });

    const committed: Array<{ segmentId: string; previousSegmentId: string | null }> = [];
    const transcripts: Array<{ segmentId: string; transcript: string; isFinal: boolean }> = [];

    session.on("committed", (payload) => {
      committed.push(payload);
    });
    session.on("transcript", (payload) => {
      transcripts.push(payload);
    });

    await session.connect();

    session.appendPcm16(Buffer.from([1, 2, 3, 4]));
    session.commit();
    session.appendPcm16(Buffer.from([5, 6, 7, 8]));
    session.commit();

    expect(committed).toHaveLength(2);
    expect(committed[1]?.segmentId).not.toBe(committed[0]?.segmentId);
    expect(committed[0]?.previousSegmentId).toBeNull();
    expect(committed[1]?.previousSegmentId).toBe(committed[0]?.segmentId);

    expect(provider.calls).toEqual([
      { audio: Buffer.from([1, 2, 3, 4]), format: "audio/pcm;rate=16000" },
      { audio: Buffer.from([5, 6, 7, 8]), format: "audio/pcm;rate=16000" },
    ]);

    provider.pending[0]?.resolve({ text: "first", duration: 1 });
    provider.pending[1]?.resolve({ text: "second", duration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transcripts).toHaveLength(2);
    expect(transcripts).toEqual([
      expect.objectContaining({
        segmentId: committed[0].segmentId,
        transcript: "first",
        isFinal: true,
      }),
      expect.objectContaining({
        segmentId: committed[1].segmentId,
        transcript: "second",
        isFinal: true,
      }),
    ]);
  });
});

/**
 * A recognizer whose decodes finish immediately, or, with `holdDecodes`, only when the test
 * releases them, like a long native decode running off the JavaScript thread.
 */
function createFakeOfflineEngine(maxDecodeSeconds: number | null, holdDecodes = false) {
  const decodedSampleCounts: number[] = [];
  const held: Array<(error?: Error) => void> = [];
  const engine = {
    sampleRate: 16000,
    maxDecodeSeconds,
    createStream: () => ({ samples: new Float32Array(0) }),
    acceptWaveform: (stream: { samples: Float32Array }, _rate: number, samples: Float32Array) => {
      stream.samples = samples;
    },
    decodeText: (stream: { samples: Float32Array }) => {
      decodedSampleCounts.push(stream.samples.length);
      const text = `s${stream.samples.length}`;
      if (!holdDecodes) {
        return Promise.resolve(text);
      }
      return new Promise<string>((resolve, reject) => {
        held.push((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(text);
        });
      });
    },
  };
  return {
    engine: engine as unknown as SherpaOfflineRecognizerEngine,
    decodedSampleCounts,
    releaseNextDecode: (error?: Error) => held.shift()?.(error),
  };
}

function tone(seconds: number): Buffer {
  const audio = Buffer.alloc(seconds * 16000 * 2);
  for (let i = 0; i < audio.length / 2; i++) {
    audio.writeInt16LE(1000, i * 2);
  }
  return audio;
}

async function collectFinals(session: SherpaParakeetRealtimeTranscriptionSession, count: number) {
  const finals: string[] = [];
  await new Promise<void>((resolve) => {
    session.on("transcript", (event: { transcript: string; isFinal: boolean }) => {
      if (event.isFinal) {
        finals.push(event.transcript);
        if (finals.length === count) resolve();
      }
    });
  });
  return finals;
}

describe("SherpaParakeetRealtimeTranscriptionSession", () => {
  it("decodes outside append and commit, finalizing replayed segments in order with progress", async () => {
    const { engine, decodedSampleCounts } = createFakeOfflineEngine(null);
    const session = new SherpaParakeetRealtimeTranscriptionSession({ engine });
    await session.connect();
    const progress: unknown[] = [];
    session.on("progress", (event) => progress.push(event));
    const finals = collectFinals(session, 2);

    // A replay delivers audio far faster than real time.
    session.appendPcm16(tone(2));
    session.commit();
    session.appendPcm16(tone(3));
    session.commit();
    expect(decodedSampleCounts).toEqual([]);

    await expect(finals).resolves.toEqual(["s32000", "s48000"]);
    // No partials were decoded for replayed audio.
    expect(decodedSampleCounts).toEqual([32000, 48000]);
    expect(progress.at(-1)).toEqual({ decodedSegments: 2, pendingSegments: 0, pendingAudioMs: 0 });
  });

  it("splits a segment longer than the recognizer window instead of discarding audio", async () => {
    const { engine, decodedSampleCounts } = createFakeOfflineEngine(30);
    const session = new SherpaParakeetRealtimeTranscriptionSession({ engine });
    await session.connect();
    const finals = collectFinals(session, 1);

    const audio = tone(70);
    // A pause at 25 s is where the first piece should end.
    audio.fill(0, 25 * 16000 * 2, Math.floor(25.1 * 16000) * 2);
    session.appendPcm16(audio);
    session.commit();

    const [transcript] = await finals;
    expect(decodedSampleCounts.every((count) => count <= 28 * 16000)).toBe(true);
    expect(decodedSampleCounts.reduce((total, count) => total + count, 0)).toBe(70 * 16000);
    expect(decodedSampleCounts[0]).toBeGreaterThanOrEqual(25 * 16000);
    expect(decodedSampleCounts[0]).toBeLessThanOrEqual(Math.ceil(25.1 * 16000));
    expect(transcript.split(" ")).toHaveLength(decodedSampleCounts.length);
  });

  it("stays responsive through a 60 second decode and reports progress while it runs", async () => {
    vi.useFakeTimers();
    try {
      const { engine, decodedSampleCounts, releaseNextDecode } = createFakeOfflineEngine(
        null,
        true,
      );
      const session = new SherpaParakeetRealtimeTranscriptionSession({ engine });
      await session.connect();
      const progress: Array<{ pendingSegments: number }> = [];
      session.on("progress", (event) => progress.push(event));
      const finals: string[] = [];
      session.on("transcript", (event: { transcript: string; isFinal: boolean }) => {
        if (event.isFinal) finals.push(event.transcript);
      });

      session.appendPcm16(tone(15));
      session.commit();
      await vi.advanceTimersByTimeAsync(1);
      expect(decodedSampleCounts).toEqual([15 * 16000]);

      // More audio and another commit arrive while the first decode is still running.
      session.appendPcm16(tone(1));
      session.commit();
      let timerFired = false;
      setTimeout(() => (timerFired = true), 30_000);
      const heartbeatsBefore = progress.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(timerFired).toBe(true);
      expect(progress.length - heartbeatsBefore).toBeGreaterThanOrEqual(10);
      expect(progress.at(-1)).toMatchObject({ pendingSegments: 1 });
      expect(decodedSampleCounts).toHaveLength(1);

      releaseNextDecode();
      await vi.advanceTimersByTimeAsync(1);
      releaseNextDecode();
      await vi.advanceTimersByTimeAsync(1);
      expect(finals).toEqual(["s240000", "s16000"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a native decode that never returns", async () => {
    vi.useFakeTimers();
    try {
      const hung = withDecodeBound(new Promise<string>(() => {}), decodeBoundMs(15_000));
      const outcome = expect(hung).rejects.toMatchObject({ code: "speech_worker_timeout" });
      await vi.advanceTimersByTimeAsync(120_000);
      await outcome;
      expect(decodeBoundMs(60_000)).toBe(240_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops heartbeats when closed or when a wedged decode fails with its typed code", async () => {
    vi.useFakeTimers();
    try {
      const { engine, releaseNextDecode } = createFakeOfflineEngine(null, true);
      const wedged = new SherpaParakeetRealtimeTranscriptionSession({ engine });
      await wedged.connect();
      const errors: Error[] = [];
      let wedgedProgress = 0;
      wedged.on("error", (error: Error) => errors.push(error));
      wedged.on("progress", () => wedgedProgress++);
      wedged.appendPcm16(tone(2));
      wedged.commit();
      await vi.advanceTimersByTimeAsync(10_000);
      releaseNextDecode(new SpeechProviderError("speech_worker_timeout", "decode overran"));
      await vi.advanceTimersByTimeAsync(1);
      const afterFailure = wedgedProgress;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "speech_worker_timeout" });
      expect(wedgedProgress).toBe(afterFailure);

      const closed = new SherpaParakeetRealtimeTranscriptionSession({ engine });
      await closed.connect();
      let closedProgress = 0;
      closed.on("progress", () => closedProgress++);
      closed.appendPcm16(tone(2));
      closed.commit();
      await vi.advanceTimersByTimeAsync(10_000);
      closed.close();
      const atClose = closedProgress;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(closedProgress).toBe(atClose);
    } finally {
      vi.useRealTimers();
    }
  });
});
