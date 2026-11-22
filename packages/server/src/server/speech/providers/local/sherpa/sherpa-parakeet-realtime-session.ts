import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";

import type { StreamingTranscriptionSession } from "../../../speech-provider.js";
import { pcm16lePeakAbs, pcm16leToFloat32 } from "../../../audio.js";
import { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";

/**
 * Partial transcripts may use at most a third of the worker's time: after a partial decode
 * that took D milliseconds, the next one waits at least this multiple of D. Decodes are
 * synchronous native calls on the worker's only thread, and Whisper pads every decode to 30
 * seconds, so one decode can take many seconds on a loaded machine.
 */
const PARTIAL_DECODE_COST_MULTIPLIER = 2;
/**
 * When a segment's audio is ahead of wall-clock time by more than this, the audio is being
 * replayed faster than real time and nobody is watching partials, so they are skipped.
 */
const REPLAY_DETECTION_SLACK_MS = 1000;

interface QueuedCommit {
  segmentId: string;
  previousSegmentId: string | null;
  pcm16: Buffer;
}

/**
 * Streams dictation through an offline recognizer by re-decoding the open segment for
 * partials and decoding each committed segment once for its final transcript.
 *
 * Decoding never runs inside the caller's `appendPcm16` or `commit`: work is scheduled with
 * `setImmediate`, one decode per turn, so the worker keeps answering IPC (appends, other
 * sessions' starts) between decodes. Final decodes of committed segments run before any
 * partial, in commit order, and always cover the whole segment.
 */
export class SherpaParakeetRealtimeTranscriptionSession
  extends EventEmitter
  implements StreamingTranscriptionSession
{
  private readonly engine: SherpaOfflineRecognizerEngine;
  private connected = false;

  public readonly requiredSampleRate: number;
  private currentSegmentId: string | null = null;
  private previousSegmentId: string | null = null;
  private lastPartialText = "";

  private pcm16: Buffer = Buffer.alloc(0);
  private segmentAudioStartedAt = 0;
  private readonly commitQueue: QueuedCommit[] = [];
  private workScheduled = false;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPartialDecodeMs = 0;
  private lastDecodeEndedAt = 0;
  private readonly minDecodeIntervalMs: number;

  constructor(params: { engine: SherpaOfflineRecognizerEngine; minDecodeIntervalMs?: number }) {
    super();
    this.engine = params.engine;
    this.requiredSampleRate = this.engine.sampleRate;
    this.minDecodeIntervalMs = params.minDecodeIntervalMs ?? 350;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.currentSegmentId = uuidv4();
    this.connected = true;
  }

  appendPcm16(chunk: Buffer): void {
    if (!this.connected || !this.currentSegmentId) {
      this.emit("error", new Error("Parakeet realtime session not connected"));
      return;
    }

    if (this.pcm16.length === 0) {
      this.segmentAudioStartedAt = Date.now();
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
    this.scheduleWork();
  }

  commit(): void {
    if (!this.connected || !this.currentSegmentId) {
      this.emit("error", new Error("Parakeet realtime session not connected"));
      return;
    }

    this.commitQueue.push({
      segmentId: this.currentSegmentId,
      previousSegmentId: this.previousSegmentId,
      pcm16: this.pcm16,
    });
    this.previousSegmentId = this.currentSegmentId;
    this.currentSegmentId = uuidv4();
    this.lastPartialText = "";
    this.pcm16 = Buffer.alloc(0);
    this.scheduleWork();
  }

  clear(): void {
    if (!this.connected) {
      return;
    }
    this.pcm16 = Buffer.alloc(0);
    this.currentSegmentId = uuidv4();
    this.lastPartialText = "";
  }

  close(): void {
    this.connected = false;
    this.currentSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
    this.commitQueue.length = 0;
    this.clearPartialTimer();
  }

  private scheduleWork(): void {
    if (this.workScheduled || !this.connected) {
      return;
    }
    this.workScheduled = true;
    setImmediate(() => {
      this.workScheduled = false;
      this.runWork();
    });
  }

  private runWork(): void {
    if (!this.connected) {
      return;
    }

    const commit = this.commitQueue.shift();
    if (commit) {
      this.finalizeSegment(commit);
      if (this.commitQueue.length > 0 || this.pcm16.length > 0) {
        this.scheduleWork();
      }
      return;
    }

    this.maybeDecodePartial();
  }

  private finalizeSegment(commit: QueuedCommit): void {
    let finalText: string;
    try {
      finalText = this.decode(commit.pcm16);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.emit("committed", {
      segmentId: commit.segmentId,
      previousSegmentId: commit.previousSegmentId,
    });
    this.emit("transcript", {
      segmentId: commit.segmentId,
      transcript: finalText,
      isFinal: true,
    });
  }

  private maybeDecodePartial(): void {
    const segmentId = this.currentSegmentId;
    if (!segmentId || this.pcm16.length === 0) {
      return;
    }

    const now = Date.now();
    const audioMs = (this.pcm16.length / 2 / this.engine.sampleRate) * 1000;
    if (audioMs > now - this.segmentAudioStartedAt + REPLAY_DETECTION_SLACK_MS) {
      // Replayed faster than real time: the final decode on commit is all that matters.
      return;
    }

    const interval = Math.max(
      this.minDecodeIntervalMs,
      this.lastPartialDecodeMs * PARTIAL_DECODE_COST_MULTIPLIER,
    );
    const waitMs = this.lastDecodeEndedAt + interval - now;
    if (waitMs > 0) {
      if (!this.partialTimer) {
        this.partialTimer = setTimeout(() => {
          this.partialTimer = null;
          this.scheduleWork();
        }, waitMs);
      }
      return;
    }

    const startedAt = Date.now();
    let text: string;
    try {
      text = this.decode(this.pcm16);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.lastPartialDecodeMs = Date.now() - startedAt;
    if (text !== this.lastPartialText && this.currentSegmentId === segmentId) {
      this.lastPartialText = text;
      this.emit("transcript", { segmentId, transcript: text, isFinal: false });
    }
  }

  private clearPartialTimer(): void {
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = null;
    }
  }

  private decode(pcm16: Buffer): string {
    if (pcm16.length === 0) {
      return "";
    }

    const peak = pcm16lePeakAbs(pcm16);
    const peakFloat = peak / 32768.0;
    const targetPeak = 0.6;
    const maxGain = 50;
    const gain =
      peakFloat > 0 && peakFloat < targetPeak ? Math.min(maxGain, targetPeak / peakFloat) : 1;

    const stream = this.engine.createStream();
    try {
      const floatSamples = pcm16leToFloat32(pcm16, gain);
      this.engine.acceptWaveform(stream, this.engine.sampleRate, floatSamples);
      this.engine.recognizer.decode(stream);
      const result = this.engine.recognizer.getResult(stream);
      return String(
        (typeof result === "object" && result && "text" in result ? result.text : undefined) ??
          result ??
          "",
      ).trim();
    } finally {
      this.lastDecodeEndedAt = Date.now();
      try {
        stream.free?.();
      } catch {
        // ignore
      }
    }
  }
}
