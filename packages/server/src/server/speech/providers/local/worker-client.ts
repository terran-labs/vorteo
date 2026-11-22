import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type pino from "pino";

import type {
  SpeechStreamResult,
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TextToSpeechProvider,
} from "../../speech-provider.js";
import type { TurnDetectionProvider, TurnDetectionSession } from "../../turn-detection-provider.js";
import { applySherpaLoaderEnv } from "./sherpa/sherpa-runtime-env.js";
import type {
  LocalSpeechCreateSessionResult,
  LocalSpeechSessionKind,
  LocalSpeechTranscriptionResult,
  LocalSpeechTtsResult,
  LocalSpeechWorkerConfig,
  LocalSpeechWorkerRequest,
  LocalSpeechWorkerResponse,
  LocalSpeechWorkerToParentMessage,
} from "./worker-protocol.js";
import { bufferToWorkerBytes, workerBytesToBuffer } from "./worker-bytes.js";
import { SpeechProviderError, isSpeechProviderError } from "../speech-provider-error.js";

/** Bound for ordinary worker requests, and for a session start that queues behind other work. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/**
 * Bound for starting a session on a worker that has already built that session kind and has
 * no other work. Creating a session on a warm worker does no model work, so a start that takes
 * this long means the worker is wedged. Measured warm starts on the Host take well under a second.
 */
const SESSION_START_WARM_TIMEOUT_MS = 8000;
/**
 * Bound for the first start of a session kind on a worker, which includes spawning the worker
 * and loading the recognizer. Host logs show 1.1 to 2.7 seconds for this (whisper-turbo,
 * parakeet) and loading whisper-turbo in-process took 2.0 seconds at a load average near 24.
 * Twenty seconds leaves wide headroom while the warm bound plus one cold retry stays under the
 * client's 30 second start wait.
 */
const SESSION_START_COLD_TIMEOUT_MS = 20000;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_SAMPLE_RATE = 16000;
const STDERR_TAIL_MAX_CHARS = 8000;
const USER_ERROR_STDERR_MAX_CHARS = 1000;

type LocalSpeechWorkerRequestInput = LocalSpeechWorkerRequest extends infer Request
  ? Request extends LocalSpeechWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

interface LocalSpeechWorkerProcess {
  connected: boolean;
  killed: boolean;
  pid?: number;
  stderr?: Readable | null;
  send(message: LocalSpeechWorkerRequest, callback: (error: Error | null) => void): boolean;
  disconnect(): void;
  kill(): boolean;
  on(event: "message", listener: (message: LocalSpeechWorkerToParentMessage) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  type: LocalSpeechWorkerRequest["type"];
  summary: Record<string, unknown>;
  startedAt: number;
}

interface LocalSpeechWorkerClientOptions {
  config: LocalSpeechWorkerConfig;
  logger: pino.Logger;
  requestTimeoutMs?: number;
  sessionStartWarmTimeoutMs?: number;
  sessionStartColdTimeoutMs?: number;
  idleTtlMs?: number;
  forkWorker?: () => LocalSpeechWorkerProcess;
}

function resolveWorkerUrl(): URL {
  const currentUrl = import.meta.url;
  if (currentUrl.endsWith(".ts")) {
    return new URL("./worker-process.ts", currentUrl);
  }
  return new URL("./worker-process.js", currentUrl);
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) {
    return [];
  }
  const loaderUrl = new URL("../../../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function forkLocalSpeechWorker(): LocalSpeechWorkerProcess {
  const env = { ...process.env };
  applySherpaLoaderEnv(env);
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    env,
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }) as LocalSpeechWorkerProcess;
}

function isResponse(
  message: LocalSpeechWorkerToParentMessage,
): message is LocalSpeechWorkerResponse {
  return message.type === "response";
}

function truncateStart(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function summarizeWorkerRequest(message: LocalSpeechWorkerRequest): Record<string, unknown> {
  switch (message.type) {
    case "session.create":
      return { kind: message.kind, sessionId: message.sessionId };
    case "session.append":
      return { sessionId: message.sessionId, audioBytes: message.audio.byteLength };
    case "session.commit":
    case "session.clear":
    case "session.flush":
    case "session.reset":
    case "session.close":
      return { sessionId: message.sessionId };
    case "stt.transcribe":
      return {
        model: message.model,
        audioBytes: message.audio.byteLength,
        format: message.format,
      };
    case "tts.synthesize":
      return { textLength: message.text.length };
  }
}

function formatExitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  const parts: string[] = [];
  if (code !== null) {
    parts.push(`code ${code}`);
  }
  if (signal) {
    parts.push(`signal ${signal}`);
  }
  return parts.length > 0 ? parts.join(", ") : "unknown exit status";
}

function formatPendingRequestForMessage(request: Record<string, unknown>): string {
  const type = typeof request.type === "string" ? request.type : "unknown request";
  const kind = typeof request.kind === "string" ? ` (${request.kind})` : "";
  return `${type}${kind}`;
}

function buildWorkerExitMessage(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  pendingRequests: Array<Record<string, unknown>>;
  stderrTail: string;
}): string {
  const pending =
    params.pendingRequests.length > 0
      ? ` while handling ${params.pendingRequests
          .slice(0, 3)
          .map(formatPendingRequestForMessage)
          .join(", ")}`
      : "";
  const stderr = params.stderrTail
    ? ` Last stderr: ${truncateStart(params.stderrTail, USER_ERROR_STDERR_MAX_CHARS)}`
    : " Check daemon.log and macOS DiagnosticReports for Vorteo Voice crash details.";
  return `Local speech worker exited (${formatExitStatus(params.code, params.signal)})${pending}.${stderr}`;
}

export class LocalSpeechWorkerClient {
  private readonly config: LocalSpeechWorkerConfig;
  private readonly logger: pino.Logger;
  private readonly requestTimeoutMs: number;
  private readonly sessionStartWarmTimeoutMs: number;
  private readonly sessionStartColdTimeoutMs: number;
  private readonly idleTtlMs: number;
  private readonly forkWorker: () => LocalSpeechWorkerProcess;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly activeSessionIds = new Set<string>();
  private readonly sessionEmitters = new Map<string, EventEmitter>();
  private worker: LocalSpeechWorkerProcess | null = null;
  private workerPid: number | null = null;
  private stderrTail = "";
  private stderrLineBuffer = "";
  private inFlightRequests = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Workers stopped on purpose, with the reason logged when their close arrives. */
  private readonly intentionalWorkerCloses = new WeakMap<LocalSpeechWorkerProcess, string>();
  /** Sessions whose start is still in progress; worker failures are reported through the start. */
  private readonly connectingSessionIds = new Set<string>();
  /** Session kinds the current worker has already built, so later starts get the warm bound. */
  private workerSessionKinds = new Set<LocalSpeechSessionKind>();
  /** Messages received from the current worker, used to tell a busy worker from a wedged one. */
  private workerMessageCount = 0;
  /** `session.create` requests that timed out; a late success must close the session it made. */
  private readonly abandonedSessionCreates = new Map<string, string>();

  constructor(options: LocalSpeechWorkerClientOptions) {
    this.config = options.config;
    this.logger = options.logger.child({ component: "local-speech-worker-client" });
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sessionStartWarmTimeoutMs =
      options.sessionStartWarmTimeoutMs ?? SESSION_START_WARM_TIMEOUT_MS;
    this.sessionStartColdTimeoutMs =
      options.sessionStartColdTimeoutMs ?? SESSION_START_COLD_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.forkWorker = options.forkWorker ?? forkLocalSpeechWorker;
  }

  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const result = await this.sendRequest<LocalSpeechTtsResult>({
      type: "tts.synthesize",
      config: this.config,
      text,
    });
    return {
      stream: Readable.from([workerBytesToBuffer(result.audio)]),
      format: result.format,
    };
  }

  transcribeVoice(audio: Buffer, format: string): Promise<LocalSpeechTranscriptionResult> {
    return this.sendRequest<LocalSpeechTranscriptionResult>({
      type: "stt.transcribe",
      config: this.config,
      model: "voice",
      audio: bufferToWorkerBytes(audio),
      format,
    });
  }

  async createSession(
    kind: LocalSpeechSessionKind,
    emitter: EventEmitter,
  ): Promise<{ sessionId: string; requiredSampleRate: number }> {
    const sessionId = randomUUID();
    this.connectingSessionIds.add(sessionId);
    try {
      for (let attempt = 1; ; attempt++) {
        // A teardown or exit during the previous attempt clears session bookkeeping.
        this.activeSessionIds.add(sessionId);
        this.sessionEmitters.set(sessionId, emitter);
        const outcome = await this.attemptSessionCreate(kind, sessionId, attempt);
        if (outcome.ok) {
          return { sessionId, requiredSampleRate: outcome.result.requiredSampleRate };
        }
        if (!outcome.retry) {
          throw outcome.error;
        }
      }
    } catch (err) {
      this.activeSessionIds.delete(sessionId);
      this.sessionEmitters.delete(sessionId);
      this.scheduleIdleShutdownIfReady();
      throw err;
    } finally {
      this.connectingSessionIds.delete(sessionId);
    }
  }

  /**
   * Starts a session once. A start that fails because the worker is unusable (timed out while
   * unresponsive, exited, or unreachable) tears that worker down and asks for one retry on a
   * fresh worker. A worker that is busy serving other sessions is never killed for a slow start:
   * if it has sent anything since this start was sent, the start fails and the worker stays.
   */
  private async attemptSessionCreate(
    kind: LocalSpeechSessionKind,
    sessionId: string,
    attempt: number,
  ): Promise<
    | { ok: true; result: LocalSpeechCreateSessionResult }
    | { ok: false; retry: boolean; error: Error }
  > {
    const canRetry = attempt === 1;
    const sentAt = Date.now();
    let worker: LocalSpeechWorkerProcess;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      const error = new SpeechProviderError(
        "speech_unavailable",
        `Local speech worker could not start: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      this.logger.warn(
        { err: error, requestType: "session.create", kind, attempt, retry: canRetry },
        "Local speech worker spawn failed",
      );
      return { ok: false, retry: canRetry, error };
    }
    const workerPid = this.workerPid;
    const messageCountAtSend = this.workerMessageCount;
    const otherWork = this.hasOtherWork(sessionId);
    const cold = !this.workerSessionKinds.has(kind);
    let timeoutMs = this.sessionStartWarmTimeoutMs;
    if (otherWork) {
      timeoutMs = this.requestTimeoutMs;
    } else if (cold) {
      timeoutMs = this.sessionStartColdTimeoutMs;
    }

    try {
      const result = await this.sendRequest<LocalSpeechCreateSessionResult>(
        { type: "session.create", config: this.config, sessionId, kind },
        {
          timeoutMs,
          logTimeout: false,
          onTimeout: (requestId) => this.abandonedSessionCreates.set(requestId, sessionId),
        },
      );
      if (this.worker === worker) {
        this.workerSessionKinds.add(kind);
      }
      return { ok: true, result };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const code = isSpeechProviderError(error) ? error.code : null;
      const elapsedMs = Date.now() - sentAt;
      const context = { workerPid, requestType: "session.create", kind, attempt, elapsedMs };

      if (code === "speech_worker_timeout") {
        const busy =
          otherWork && this.worker === worker && this.workerMessageCount > messageCountAtSend;
        if (busy) {
          this.logger.warn(
            { ...context, timeoutMs, retry: false, workerState: "busy" },
            "Local speech session start timed out behind other work; keeping the worker",
          );
          return { ok: false, retry: false, error };
        }
        this.logger.warn(
          { ...context, timeoutMs, retry: canRetry, workerState: "unresponsive" },
          "Local speech session start timed out; replacing the worker",
        );
        this.teardownWorker(worker, "session.create timed out", sessionId);
        return { ok: false, retry: canRetry, error };
      }
      if (code === "speech_worker_exited" || code === "speech_unavailable") {
        this.logger.warn(
          { ...context, err: error, retry: canRetry },
          "Local speech session start failed because the worker is unusable",
        );
        return { ok: false, retry: canRetry, error };
      }
      // The worker answered with an error, such as a missing model; a new worker would too.
      return { ok: false, retry: false, error };
    }
  }

  private hasOtherWork(sessionId: string): boolean {
    for (const activeId of this.activeSessionIds) {
      if (activeId !== sessionId) {
        return true;
      }
    }
    return this.pendingRequests.size > 0;
  }

  /**
   * Replaces an unresponsive worker. Its pending requests and its other sessions fail with
   * `speech_worker_timeout`, because they were waiting on the same unresponsive process.
   */
  private teardownWorker(
    worker: LocalSpeechWorkerProcess,
    reason: string,
    retainedSessionId: string,
  ): void {
    if (this.worker !== worker) {
      return;
    }
    const error = new SpeechProviderError(
      "speech_worker_timeout",
      `Local speech worker stopped responding (${reason})`,
    );
    const failedSessionIds = Array.from(this.activeSessionIds).filter(
      (id) => id !== retainedSessionId && !this.connectingSessionIds.has(id),
    );
    this.logger.warn(
      {
        workerPid: this.workerPid,
        reason,
        pendingRequests: this.describePendingRequests(),
        failedSessionCount: failedSessionIds.length,
      },
      "Tearing down unresponsive local speech worker",
    );
    const emitters = failedSessionIds.map((id) => [id, this.sessionEmitters.get(id)] as const);
    for (const id of failedSessionIds) {
      this.activeSessionIds.delete(id);
      this.sessionEmitters.delete(id);
    }
    this.stopWorker(error, reason);
    for (const [id, emitter] of emitters) {
      if (emitter) {
        this.emitErrorIfObserved(id, emitter, error);
      }
    }
  }

  appendSessionAudio(sessionId: string, audio: Buffer): void {
    void this.sendRequest({
      type: "session.append",
      sessionId,
      audio: bufferToWorkerBytes(audio),
    }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  commitSession(sessionId: string): void {
    void this.sendRequest({ type: "session.commit", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  clearSession(sessionId: string): void {
    void this.sendRequest({ type: "session.clear", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  flushSession(sessionId: string): void {
    void this.sendRequest({ type: "session.flush", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  resetSession(sessionId: string): void {
    void this.sendRequest({ type: "session.reset", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  closeSession(sessionId: string): void {
    this.activeSessionIds.delete(sessionId);
    this.sessionEmitters.delete(sessionId);
    void this.sendRequest({ type: "session.close", sessionId }).catch(() => {
      // Closing is best-effort; the parent already dropped the session.
    });
    this.scheduleIdleShutdownIfReady();
  }

  shutdown(): void {
    this.activeSessionIds.clear();
    this.sessionEmitters.clear();
    this.stopWorker(
      new SpeechProviderError("speech_unavailable", "Local speech worker shut down"),
      "shutdown",
    );
  }

  /** Stops the current worker as an intentional close and rejects its pending requests. */
  private stopWorker(error: Error, reason: string): void {
    this.clearIdleTimer();
    this.rejectAllPending(error);
    this.inFlightRequests = 0;
    const worker = this.worker;
    this.worker = null;
    this.workerPid = null;
    if (worker && !worker.killed) {
      this.intentionalWorkerCloses.set(worker, reason);
      try {
        worker.disconnect();
      } catch {
        // ignore
      }
      try {
        worker.kill();
      } catch {
        // ignore
      }
    }
  }

  private sendRequest<T = void>(
    input: LocalSpeechWorkerRequestInput,
    options: {
      timeoutMs?: number;
      logTimeout?: boolean;
      onTimeout?: (requestId: string) => void;
    } = {},
  ): Promise<T> {
    let worker: LocalSpeechWorkerProcess;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      return Promise.reject(
        new SpeechProviderError(
          "speech_unavailable",
          `Local speech worker could not start: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      );
    }
    const requestId = randomUUID();
    const message = { ...input, requestId } as LocalSpeechWorkerRequest;
    const requestSummary = summarizeWorkerRequest(message);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    this.inFlightRequests++;
    this.clearIdleTimer();

    return new Promise<T>((resolve, reject) => {
      const startedAt = Date.now();
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        options.onTimeout?.(requestId);
        if (options.logTimeout !== false) {
          this.logger.warn(
            {
              workerPid: worker.pid ?? null,
              requestId,
              requestType: input.type,
              elapsedMs: Date.now() - startedAt,
              retry: false,
              ...requestSummary,
            },
            "Local speech worker request timed out",
          );
        }
        this.scheduleIdleShutdownIfReady();
        reject(
          new SpeechProviderError(
            "speech_worker_timeout",
            `Local speech worker request timed out: ${input.type}`,
          ),
        );
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        type: message.type,
        summary: requestSummary,
        startedAt,
      });

      worker.send(message, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        this.scheduleIdleShutdownIfReady();
        pending.reject(
          new SpeechProviderError("speech_unavailable", error.message, { cause: error }),
        );
      });
    });
  }

  private ensureWorker(): LocalSpeechWorkerProcess {
    if (this.worker && !this.worker.killed && this.worker.connected) {
      return this.worker;
    }
    const replacedWorker = this.worker !== null;
    const worker = this.forkWorker();
    this.worker = worker;
    this.workerPid = worker.pid ?? null;
    this.workerSessionKinds = new Set();
    this.workerMessageCount = 0;
    // Abandoned starts belonged to the previous worker, which is gone.
    this.abandonedSessionCreates.clear();
    this.stderrTail = "";
    this.stderrLineBuffer = "";
    this.logger.info(
      {
        workerPid: this.workerPid,
        modelsDir: this.config.modelsDir,
        voiceSttModel: this.config.voiceSttModel,
        dictationSttModel: this.config.dictationSttModel,
        voiceTtsModel: this.config.voiceTtsModel,
        replacedWorker,
      },
      "Local speech worker spawned",
    );
    worker.stderr?.on("data", (chunk: Buffer | string) => this.handleWorkerStderr(chunk));
    worker.on("message", (message) => this.handleWorkerMessage(worker, message));
    worker.on("close", (code, signal) => this.handleWorkerExit(worker, code, signal));
    return worker;
  }

  private handleWorkerStderr(chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    this.stderrTail = truncateStart(this.stderrTail + text, STDERR_TAIL_MAX_CHARS);

    this.stderrLineBuffer += text;
    const lines = this.stderrLineBuffer.split(/\r?\n/);
    this.stderrLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.logger.warn(
        { workerPid: this.workerPid, stderr: trimmed },
        "Local speech worker stderr",
      );
    }
  }

  private handleWorkerMessage(
    worker: LocalSpeechWorkerProcess,
    message: LocalSpeechWorkerToParentMessage,
  ): void {
    if (this.worker !== worker) {
      // A replaced worker's late messages must not touch the new worker's sessions.
      return;
    }
    this.workerMessageCount++;
    if (isResponse(message)) {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) {
        this.closeAbandonedSession(message);
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.requestId);
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
      this.scheduleIdleShutdownIfReady();
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
      return;
    }

    const emitter = this.sessionEmitters.get(message.sessionId);
    if (!emitter) {
      return;
    }
    switch (message.type) {
      case "session.committed":
        emitter.emit("committed", message.payload);
        return;
      case "session.transcript":
        emitter.emit("transcript", message.payload);
        return;
      case "session.speech_started":
        emitter.emit("speech_started");
        return;
      case "session.speech_stopped":
        emitter.emit("speech_stopped");
        return;
      case "session.error":
        emitter.emit("error", new Error(message.error));
        return;
    }
  }

  private handleWorkerExit(
    worker: LocalSpeechWorkerProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const wasCurrentWorker = this.worker === worker;
    const intentionalCloseReason = this.intentionalWorkerCloses.get(worker);
    const wasIntentionalClose = intentionalCloseReason !== undefined;
    this.intentionalWorkerCloses.delete(worker);
    const workerPid = worker.pid ?? (wasCurrentWorker ? this.workerPid : null);
    const pendingRequests = this.describePendingRequests();
    const activeSessionCount = this.activeSessionIds.size;
    const stderrTail = this.getStderrTail();

    if (wasIntentionalClose) {
      this.logger.info(
        {
          workerPid,
          reason: intentionalCloseReason,
          code,
          signal,
          pendingRequests,
          activeSessionCount,
          stderrTail: stderrTail || null,
        },
        "Local speech worker closed after shutdown",
      );
      if (wasCurrentWorker) {
        this.worker = null;
        this.workerPid = null;
      }
      return;
    }

    if (!wasCurrentWorker) {
      this.logger.warn(
        {
          workerPid,
          code,
          signal,
          pendingRequests,
          activeSessionCount,
          stderrTail: stderrTail || null,
        },
        "Stale local speech worker closed",
      );
      return;
    }

    const error = new SpeechProviderError(
      "speech_worker_exited",
      buildWorkerExitMessage({
        code,
        signal,
        pendingRequests,
        stderrTail,
      }),
    );

    this.logger.error(
      {
        err: error,
        workerPid,
        code,
        signal,
        pendingRequests,
        activeSessionCount,
        stderrTail: stderrTail || null,
      },
      "Local speech worker exited",
    );

    if (wasCurrentWorker) {
      this.worker = null;
      this.workerPid = null;
    }
    this.clearIdleTimer();
    this.rejectAllPending(error);
    for (const [sessionId, emitter] of this.sessionEmitters) {
      // A session still starting learns about the exit from its start request instead.
      if (this.activeSessionIds.has(sessionId) && !this.connectingSessionIds.has(sessionId)) {
        this.emitErrorIfObserved(sessionId, emitter, error, workerPid);
      }
    }
    this.activeSessionIds.clear();
    this.sessionEmitters.clear();
    this.inFlightRequests = 0;
  }

  /** A start that already timed out may still succeed in the worker; close what it created. */
  private closeAbandonedSession(message: LocalSpeechWorkerResponse): void {
    const sessionId = this.abandonedSessionCreates.get(message.requestId);
    if (!sessionId) {
      return;
    }
    this.abandonedSessionCreates.delete(message.requestId);
    if (!message.ok || this.activeSessionIds.has(sessionId)) {
      // Nothing was created, or a retry reused this session ID and now owns it.
      return;
    }
    this.logger.warn(
      { workerPid: this.workerPid, requestId: message.requestId, sessionId },
      "Closing local speech session created after its start timed out",
    );
    void this.sendRequest({ type: "session.close", sessionId }).catch(() => {
      // Best effort: the worker is replaced or shutting down.
    });
    this.scheduleIdleShutdownIfReady();
  }

  private describePendingRequests(): Array<Record<string, unknown>> {
    const now = Date.now();
    return Array.from(this.pendingRequests.entries()).map(([requestId, request]) =>
      Object.assign(
        {
          requestId,
          type: request.type,
          ageMs: Math.max(0, now - request.startedAt),
        },
        request.summary,
      ),
    );
  }

  private getStderrTail(): string {
    return truncateStart(this.stderrTail.trim(), STDERR_TAIL_MAX_CHARS);
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  private emitSessionError(sessionId: string, error: unknown): void {
    const emitter = this.sessionEmitters.get(sessionId);
    if (!emitter) {
      return;
    }
    this.emitErrorIfObserved(
      sessionId,
      emitter,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private emitErrorIfObserved(
    sessionId: string,
    emitter: EventEmitter,
    error: Error,
    workerPid: number | null = this.workerPid,
  ): void {
    if (emitter.listenerCount("error") > 0) {
      emitter.emit("error", error);
      return;
    }
    this.logger.warn(
      { err: error, workerPid, sessionId },
      "Local speech worker session error had no listener",
    );
  }

  private scheduleIdleShutdownIfReady(): void {
    if (!this.worker || this.inFlightRequests > 0 || this.activeSessionIds.size > 0) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.inFlightRequests === 0 && this.activeSessionIds.size === 0) {
        this.shutdown();
      }
    }, this.idleTtlMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export class WorkerBackedTextToSpeechProvider implements TextToSpeechProvider {
  constructor(private readonly client: LocalSpeechWorkerClient) {}

  synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    return this.client.synthesizeSpeech(text);
  }
}

export class WorkerBackedSpeechToTextProvider implements SpeechToTextProvider {
  public readonly id = "local" as const;

  constructor(
    private readonly client: LocalSpeechWorkerClient,
    private readonly kind: Extract<LocalSpeechSessionKind, "voiceStt" | "dictationStt">,
  ) {}

  createSession(_params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    return new WorkerBackedTranscriptionSession(this.client, this.kind);
  }
}

export class WorkerBackedTurnDetectionProvider implements TurnDetectionProvider {
  public readonly id = "local" as const;

  constructor(private readonly client: LocalSpeechWorkerClient) {}

  createSession(_params: { logger: pino.Logger }): TurnDetectionSession {
    return new WorkerBackedTurnDetectionSession(this.client);
  }
}

class WorkerBackedTranscriptionSession
  extends EventEmitter
  implements StreamingTranscriptionSession
{
  public requiredSampleRate = DEFAULT_LOCAL_SAMPLE_RATE;
  private connectedSessionId: string | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly client: LocalSpeechWorkerClient,
    private readonly kind: Extract<LocalSpeechSessionKind, "voiceStt" | "dictationStt">,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connectedSessionId) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connectRemoteSession();
    }
    await this.connecting;
  }

  private async connectRemoteSession(): Promise<void> {
    try {
      const result = await this.client.createSession(this.kind, this);
      this.connectedSessionId = result.sessionId;
      this.requiredSampleRate = result.requiredSampleRate;
    } finally {
      this.connecting = null;
    }
  }

  appendPcm16(pcm16le: Buffer): void {
    const sessionId = this.connectedSessionId;
    if (!sessionId) {
      this.emit("error", new Error("Local STT session not connected"));
      return;
    }
    this.client.appendSessionAudio(sessionId, pcm16le);
  }

  commit(): void {
    const sessionId = this.connectedSessionId;
    if (!sessionId) {
      this.emit("error", new Error("Local STT session not connected"));
      return;
    }
    this.client.commitSession(sessionId);
  }

  clear(): void {
    const sessionId = this.connectedSessionId;
    if (sessionId) {
      this.client.clearSession(sessionId);
    }
  }

  close(): void {
    const sessionId = this.connectedSessionId;
    this.connectedSessionId = null;
    if (sessionId) {
      this.client.closeSession(sessionId);
    }
  }
}

class WorkerBackedTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public requiredSampleRate = DEFAULT_LOCAL_SAMPLE_RATE;
  private connectedSessionId: string | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly client: LocalSpeechWorkerClient) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connectedSessionId) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connectRemoteSession();
    }
    await this.connecting;
  }

  private async connectRemoteSession(): Promise<void> {
    try {
      const result = await this.client.createSession("vad", this);
      this.connectedSessionId = result.sessionId;
      this.requiredSampleRate = result.requiredSampleRate;
    } finally {
      this.connecting = null;
    }
  }

  appendPcm16(pcm16le: Buffer): void {
    const sessionId = this.connectedSessionId;
    if (!sessionId) {
      this.emit("error", new Error("Local turn-detection session not connected"));
      return;
    }
    this.client.appendSessionAudio(sessionId, pcm16le);
  }

  flush(): void {
    const sessionId = this.connectedSessionId;
    if (sessionId) {
      this.client.flushSession(sessionId);
    }
  }

  reset(): void {
    const sessionId = this.connectedSessionId;
    if (sessionId) {
      this.client.resetSession(sessionId);
    }
  }

  close(): void {
    const sessionId = this.connectedSessionId;
    this.connectedSessionId = null;
    if (sessionId) {
      this.client.closeSession(sessionId);
    }
  }
}
