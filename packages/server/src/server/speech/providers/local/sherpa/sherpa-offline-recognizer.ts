import { existsSync } from "node:fs";
import path from "node:path";
import type pino from "pino";

import { engineFiles, type SttEngine } from "./model-catalog.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";
import { SpeechProviderError } from "../../speech-provider-error.js";

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

// Each engine family takes its own block under sherpa's modelConfig.
function buildModelConfig(modelDir: string, engine: SttEngine): Record<string, unknown> {
  const file = (name: string) => path.join(modelDir, name);
  switch (engine.family) {
    case "transducer":
      return {
        transducer: {
          encoder: file(engine.encoder),
          decoder: file(engine.decoder),
          joiner: file(engine.joiner),
        },
        modelType: "nemo_transducer",
      };
    case "whisper":
      // An empty language makes Whisper detect the spoken language.
      return {
        whisper: {
          encoder: file(engine.encoder),
          decoder: file(engine.decoder),
          language: "",
          task: "transcribe",
        },
      };
    case "sense_voice":
      return {
        senseVoice: { model: file(engine.model), language: "", useInverseTextNormalization: 1 },
      };
    case "dolphin":
      return { dolphin: { model: file(engine.model) } };
    case "nemo_ctc":
      return { nemoCtc: { model: file(engine.model) } };
  }
}

export interface SherpaOfflineRecognizerConfig {
  modelDir: string;
  engine: SttEngine;
  numThreads?: number;
  provider?: "cpu";
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
}

interface SherpaOfflineRecognizerNative {
  config?: { featConfig?: { sampleRate?: number } };
  createStream: () => unknown;
  decode: (stream: unknown) => void;
  /** Decodes on libuv's thread pool; present in sherpa-onnx-node 1.12 and later. */
  decodeAsync?: (stream: unknown) => Promise<{ text?: string } | string | undefined>;
  getResult: (stream: unknown) => { text?: string } | string | undefined;
  free?: () => void;
}

interface SherpaOfflineStreamNative {
  acceptWaveform: ((arg: { samples: Float32Array; sampleRate: number }) => void) &
    ((sampleRate: number, samples: Float32Array) => void);
  free?: () => void;
}

function resultText(result: { text?: string } | string | undefined): string {
  return String(
    (typeof result === "object" && result && "text" in result ? result.text : undefined) ??
      result ??
      "",
  ).trim();
}

/**
 * Longest one decode may run before the recognizer is treated as wedged: four times the audio
 * length, and never less than two minutes. Measured decodes take 0.2 to 4 times the audio
 * length (whisper-turbo on efficiency cores under load is the slowest).
 */
const MIN_DECODE_BOUND_MS = 120_000;
const DECODE_BOUND_AUDIO_MULTIPLIER = 4;

export function decodeBoundMs(audioMs: number): number {
  return Math.max(MIN_DECODE_BOUND_MS, DECODE_BOUND_AUDIO_MULTIPLIER * audioMs);
}

/**
 * Rejects with `speech_worker_timeout` when `decode` has not settled within `boundMs`. A native
 * decode cannot be cancelled, so the caller must give up on the whole recognizer.
 */
export function withDecodeBound<T>(decode: Promise<T>, boundMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SpeechProviderError(
            "speech_worker_timeout",
            `Local speech decode did not finish within ${Math.round(boundMs / 1000)} s`,
          ),
        ),
      boundMs,
    );
  });
  return Promise.race([decode, bound]).finally(() => clearTimeout(timer));
}

export class SherpaOfflineRecognizerEngine {
  public readonly recognizer: SherpaOfflineRecognizerNative;
  public readonly sampleRate: number;
  /**
   * Longest audio one decode covers, or null when unbounded. Sherpa's Whisper decodes only the
   * first 30 seconds and discards the rest with a stderr warning.
   */
  public readonly maxDecodeSeconds: number | null;
  private readonly logger: pino.Logger;
  private decodeQueue: Promise<unknown> = Promise.resolve();
  /** Set when a decode overran its bound; the native call may still hold the recognizer. */
  private wedgedError: Error | null = null;

  constructor(config: SherpaOfflineRecognizerConfig, logger: pino.Logger) {
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "offline-recognizer",
    });

    for (const name of engineFiles(config.engine)) {
      assertFileExists(path.join(config.modelDir, name), `${config.engine.family} model file`);
    }

    this.maxDecodeSeconds = config.engine.family === "whisper" ? 30 : null;
    const sherpa = loadSherpaOnnxNode();

    const recognizerConfig = {
      featConfig: {
        sampleRate: config.sampleRate ?? 16000,
        featureDim: config.featureDim ?? 80,
      },
      modelConfig: {
        ...buildModelConfig(config.modelDir, config.engine),
        tokens: path.join(config.modelDir, config.engine.tokens),
        numThreads: config.numThreads ?? 1,
        provider: config.provider ?? "cpu",
        debug: config.debug ?? 0,
      },
      decodingMethod: config.decodingMethod ?? "greedy_search",
      maxActivePaths: config.maxActivePaths ?? 4,
    };

    this.recognizer = new (
      sherpa as unknown as {
        OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizerNative;
      }
    ).OfflineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate =
      typeof sr === "number" && Number.isFinite(sr) && sr > 0
        ? sr
        : recognizerConfig.featConfig.sampleRate;

    this.logger.info(
      { sampleRate: this.sampleRate, numThreads: recognizerConfig.modelConfig.numThreads },
      "Sherpa offline recognizer initialized",
    );
  }

  createStream(): SherpaOfflineStreamNative {
    return this.recognizer.createStream() as SherpaOfflineStreamNative;
  }

  acceptWaveform(
    stream: SherpaOfflineStreamNative,
    sampleRate: number,
    samples: Float32Array,
  ): void {
    if (!stream || typeof stream.acceptWaveform !== "function") {
      throw new Error("Unexpected sherpa offline stream: missing acceptWaveform()");
    }

    // sherpa-onnx-node expects: acceptWaveform({ samples, sampleRate })
    // sherpa-onnx (WASM) expects: acceptWaveform(sampleRate, samples)
    if (stream.acceptWaveform.length <= 1) {
      stream.acceptWaveform({ samples, sampleRate });
    } else {
      stream.acceptWaveform(sampleRate, samples);
    }
  }

  /**
   * Decodes a stream and returns its trimmed text. The native decode runs off the JavaScript
   * thread when the binding supports it, so the worker keeps answering IPC during a decode that
   * can take tens of seconds. Decodes on one recognizer run one at a time, because voice and
   * dictation sessions can share it. A decode that overruns `decodeBoundMs(audioMs)` marks the
   * recognizer wedged: it and every later decode reject with `speech_worker_timeout`, and the
   * worker process must be replaced.
   */
  decodeText(stream: SherpaOfflineStreamNative, audioMs: number): Promise<string> {
    const run = async (): Promise<string> => {
      if (this.wedgedError) {
        throw this.wedgedError;
      }
      if (typeof this.recognizer.decodeAsync === "function") {
        try {
          return resultText(
            await withDecodeBound(this.recognizer.decodeAsync(stream), decodeBoundMs(audioMs)),
          );
        } catch (err) {
          if (err instanceof SpeechProviderError && err.code === "speech_worker_timeout") {
            this.wedgedError = err;
            this.logger.warn({ audioMs }, "Sherpa offline decode overran its bound");
          }
          throw err;
        }
      }
      this.recognizer.decode(stream);
      return resultText(this.recognizer.getResult(stream));
    };
    const decoded = this.decodeQueue.then(run, run);
    this.decodeQueue = decoded.catch(() => undefined);
    return decoded;
  }

  free(): void {
    try {
      this.recognizer?.free?.();
    } catch (err) {
      this.logger.warn({ err }, "Failed to free sherpa offline recognizer");
    }
  }
}
