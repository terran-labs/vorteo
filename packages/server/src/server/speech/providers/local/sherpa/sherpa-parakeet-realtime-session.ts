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
/**
 * A segment longer than the recognizer's window is split at the quietest 100 ms frame in the
 * last few seconds before this length, so nothing beyond the window is discarded.
 */
const WINDOW_SPLIT_MARGIN_SECONDS = 2;
const WINDOW_SPLIT_SEARCH_SECONDS = 8;
const SPLIT_FRAME_MS = 100;
/** While a final decode runs, `progress` repeats at this interval so waiters see the worker live. */
const PROGRESS_HEARTBEAT_MS = 5000;

interface QueuedCommit {
  segmentId: string;
  previousSegmentId: string | null;
  pcm16: Buffer;
}

/** Decoding progress, emitted as `progress` after each commit is queued and each is decoded. */
export interface RealtimeTranscriptionProgress {
  decodedSegments: number;
  pendingSegments: number;
  pendingAudioMs: number;
}

/**
 * Splits PCM16 audio into pieces no longer than `maxSamples`, cutting each piece at its
 * quietest frame within the search span before the limit so words are rarely split.
 */
export function splitPcm16ForWindow(
  pcm16: Buffer,
  sampleRate: number,
  maxSeconds: number,
): Buffer[] {
  const maxSamples = Math.floor((maxSeconds - WINDOW_SPLIT_MARGIN_SECONDS) * sampleRate);
  const frameSamples = Math.max(1, Math.floor((SPLIT_FRAME_MS / 1000) * sampleRate));
  const searchSamples = Math.floor(WINDOW_SPLIT_SEARCH_SECONDS * sampleRate);
  const totalSamples = Math.floor(pcm16.length / 2);
  const pieces: Buffer[] = [];
  let start = 0;
  while (totalSamples - start > maxSamples) {
    let cut = start + maxSamples;
    let quietest = Number.POSITIVE_INFINITY;
    for (
      let frame = start + maxSamples - frameSamples;
      frame >= start + maxSamples - searchSamples && frame > start;
      frame -= frameSamples
    ) {
      let energy = 0;
      for (let i = frame; i < frame + frameSamples; i++) {
        energy += Math.abs(pcm16.readInt16LE(i * 2));
      }
      if (energy < quietest) {
        quietest = energy;
        cut = frame + Math.floor(frameSamples / 2);
      }
    }
    pieces.push(pcm16.subarray(start * 2, cut * 2));
    start = cut;
  }
  pieces.push(pcm16.subarray(start * 2, totalSamples * 2));
  return pieces;
}

/**
 * Streams dictation through an offline recognizer by re-decoding the open segment for
 * partials and decoding each committed segment once for its final transcript.
 *
 * Decoding never runs inside the caller's `appendPcm16` or `commit`. Work is scheduled with
 * `setImmediate` and each native decode runs off the JavaScript thread (`decodeText`), so the
 * worker keeps answering IPC (appends, other sessions' starts) even during a long decode.
 * Final decodes of committed segments run before any partial, one at a time, in commit order,
 * and always cover the whole segment. `progress` fires when a commit is queued, after each
 * segment is decoded, and every few seconds while a final decode runs.
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

  /** Open segment audio, kept as received and joined only when decoded. */
  private pcmChunks: Buffer[] = [];
  private pcmBytes = 0;
  private segmentAudioStartedAt = 0;
  private decodedSegments = 0;
  private readonly commitQueue: QueuedCommit[] = [];
  private workScheduled = false;
  /** True while a decode is in flight; decodes for one session run one at a time. */
  private working = false;
  private workRequestedWhileBusy = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
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

    if (this.pcmBytes === 0) {
      this.segmentAudioStartedAt = Date.now();
    }
    this.pcmChunks.push(chunk);
    this.pcmBytes += chunk.length;
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
      pcm16: this.takeOpenAudio(),
    });
    this.previousSegmentId = this.currentSegmentId;
    this.currentSegmentId = uuidv4();
    this.lastPartialText = "";
    this.emitProgress();
    this.scheduleWork();
  }

  clear(): void {
    if (!this.connected) {
      return;
    }
    this.takeOpenAudio();
    this.currentSegmentId = uuidv4();
    this.lastPartialText = "";
  }

  close(): void {
    this.connected = false;
    this.currentSegmentId = null;
    this.takeOpenAudio();
    this.commitQueue.length = 0;
    this.clearPartialTimer();
    this.stopHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleWork(): void {
    if (this.workScheduled || !this.connected) {
      return;
    }
    if (this.working) {
      // The running loop looks again when the current decode finishes.
      this.workRequestedWhileBusy = true;
      return;
    }
    this.workScheduled = true;
    setImmediate(() => {
      this.workScheduled = false;
      void this.runWork();
    });
  }

  private async runWork(): Promise<void> {
    if (!this.connected || this.working) {
      return;
    }
    this.working = true;
    this.workRequestedWhileBusy = false;
    let finalized = false;
    try {
      const commit = this.commitQueue.shift();
      if (commit) {
        finalized = true;
        await this.finalizeSegment(commit);
      } else {
        await this.maybeDecodePartial();
      }
    } finally {
      this.working = false;
    }
    // Look again only for real work, so skipped partials never spin the loop.
    if (this.commitQueue.length > 0 || (finalized && this.pcmBytes > 0)) {
      this.scheduleWork();
    } else if (this.workRequestedWhileBusy) {
      this.workRequestedWhileBusy = false;
      this.scheduleWork();
    }
  }

  private async finalizeSegment(commit: QueuedCommit): Promise<void> {
    // The worker's thread is free during the decode, so keep reporting that work continues. The
    // engine bounds each decode, so a hung native call cannot keep this alive forever.
    this.heartbeat = setInterval(() => {
      if (this.connected) {
        this.emitProgress();
      } else {
        this.stopHeartbeat();
      }
    }, PROGRESS_HEARTBEAT_MS);
    let finalText: string;
    try {
      const window = this.windowSeconds();
      const pieces = window
        ? splitPcm16ForWindow(commit.pcm16, this.engine.sampleRate, window)
        : [commit.pcm16];
      const texts: string[] = [];
      for (const piece of pieces) {
        texts.push(await this.decode(piece));
      }
      finalText = texts.filter((text) => text.length > 0).join(" ");
    } catch (err) {
      if (this.connected) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
      return;
    } finally {
      this.stopHeartbeat();
      this.decodedSegments++;
    }
    if (!this.connected) {
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
    this.emitProgress();
  }

  private emitProgress(): void {
    const pendingBytes = this.commitQueue.reduce((total, commit) => total + commit.pcm16.length, 0);
    const progress: RealtimeTranscriptionProgress = {
      decodedSegments: this.decodedSegments,
      pendingSegments: this.commitQueue.length,
      pendingAudioMs: Math.round((pendingBytes / 2 / this.engine.sampleRate) * 1000),
    };
    this.emit("progress", progress);
  }

  private takeOpenAudio(): Buffer {
    const audio =
      this.pcmChunks.length === 1
        ? this.pcmChunks[0]
        : Buffer.concat(this.pcmChunks, this.pcmBytes);
    this.pcmChunks = [];
    this.pcmBytes = 0;
    return audio;
  }

  private openAudio(): Buffer {
    if (this.pcmChunks.length > 1) {
      // Join once and keep the joined buffer, so repeated partials do not re-copy every chunk.
      this.pcmChunks = [Buffer.concat(this.pcmChunks, this.pcmBytes)];
    }
    return this.pcmChunks[0] ?? Buffer.alloc(0);
  }

  private windowSeconds(): number | null {
    return this.engine.maxDecodeSeconds ?? null;
  }

  private async maybeDecodePartial(): Promise<void> {
    const segmentId = this.currentSegmentId;
    if (!segmentId || this.pcmBytes === 0) {
      return;
    }

    const now = Date.now();
    const audioMs = (this.pcmBytes / 2 / this.engine.sampleRate) * 1000;
    if (audioMs > now - this.segmentAudioStartedAt + REPLAY_DETECTION_SLACK_MS) {
      // Replayed faster than real time: the final decode on commit is all that matters.
      return;
    }
    const windowSeconds = this.windowSeconds();
    if (windowSeconds && audioMs > (windowSeconds - WINDOW_SPLIT_MARGIN_SECONDS) * 1000) {
      // Past the recognizer's window a partial would show only the start; the final splits.
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
      text = await this.decode(this.openAudio());
    } catch (err) {
      if (this.connected) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    this.lastPartialDecodeMs = Date.now() - startedAt;
    if (this.connected && text !== this.lastPartialText && this.currentSegmentId === segmentId) {
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

  private async decode(pcm16: Buffer): Promise<string> {
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
      return await this.engine.decodeText(
        stream,
        (floatSamples.length / this.engine.sampleRate) * 1000,
      );
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
