import { EventEmitter } from "node:events";
import { once } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  LocalSpeechWorkerClient,
  WorkerBackedSpeechToTextProvider,
  WorkerBackedTextToSpeechProvider,
  WorkerBackedTurnDetectionProvider,
} from "./worker-client.js";
import type {
  LocalSpeechWorkerRequest,
  LocalSpeechWorkerToParentMessage,
} from "./worker-protocol.js";
import { bufferToWorkerBytes, workerBytesToBuffer } from "./worker-bytes.js";

class FakeLocalSpeechWorker extends EventEmitter {
  public connected = true;
  public killed = false;
  public pid = 12345;
  public readonly stderr = new EventEmitter() as NodeJS.ReadableStream;
  public readonly sent: LocalSpeechWorkerRequest[] = [];
  public disconnects = 0;
  public kills = 0;

  send(message: LocalSpeechWorkerRequest, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => callback(null));
    return true;
  }

  disconnect(): void {
    this.disconnects++;
    this.connected = false;
  }

  kill(): boolean {
    this.kills++;
    this.killed = true;
    this.connected = false;
    return true;
  }

  respond(request: LocalSpeechWorkerRequest, result?: unknown): void {
    this.emit("message", {
      type: "response",
      requestId: request.requestId,
      ok: true,
      result,
    } satisfies LocalSpeechWorkerToParentMessage);
  }

  emitWorkerMessage(message: LocalSpeechWorkerToParentMessage): void {
    this.emit("message", message);
  }
}

class PausedIpcWorker {
  private readonly child: ChildProcess;

  constructor() {
    this.child = fork(
      fileURLToPath(new URL("./test-fixtures/paused-ipc-worker.cjs", import.meta.url)),
      [],
      { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
  }

  get connected(): boolean {
    return this.child.connected;
  }

  get killed(): boolean {
    return this.child.killed;
  }

  send(message: LocalSpeechWorkerRequest, callback: (error: Error | null) => void): boolean {
    return this.child.send(message, (error) => callback(error ?? null));
  }

  disconnect(): void {
    this.child.disconnect();
  }

  kill(): boolean {
    return this.child.kill();
  }

  on(event: "message", listener: (message: LocalSpeechWorkerToParentMessage) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(
    event: "message" | "close",
    listener:
      | ((message: LocalSpeechWorkerToParentMessage) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    this.child.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
}

function createClient(options?: {
  idleTtlMs?: number;
  requestTimeoutMs?: number;
  sessionStartBudgetMs?: number;
  sessionStartWarmTimeoutMs?: number;
  sessionStartColdTimeoutMs?: number;
}) {
  const workers: FakeLocalSpeechWorker[] = [];
  const client = new LocalSpeechWorkerClient({
    logger: pino({ level: "silent" }),
    config: {
      modelsDir: "/tmp/models",
      voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
      dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
      voiceTtsModel: "kokoro-en-v0_19",
    },
    requestTimeoutMs: options?.requestTimeoutMs ?? 1000,
    sessionStartBudgetMs: options?.sessionStartBudgetMs,
    sessionStartWarmTimeoutMs: options?.sessionStartWarmTimeoutMs,
    sessionStartColdTimeoutMs: options?.sessionStartColdTimeoutMs,
    idleTtlMs: options?.idleTtlMs ?? 1000,
    forkWorker: () => {
      const worker = new FakeLocalSpeechWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { client, workers };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sentOfType(worker: FakeLocalSpeechWorker, type: LocalSpeechWorkerRequest["type"]) {
  return worker.sent.filter((request) => request.type === type);
}

function createCapturingLogger(): { logger: pino.Logger; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, records };
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LocalSpeechWorkerClient", () => {
  it("does not spawn the worker until first local speech use", () => {
    const { workers } = createClient();

    expect(workers).toHaveLength(0);
  });

  it("sends TTS requests through the worker and returns the audio stream", async () => {
    const { client, workers } = createClient();
    const provider = new WorkerBackedTextToSpeechProvider(client);

    const pending = provider.synthesizeSpeech("hello");
    expect(workers).toHaveLength(1);
    const request = workers[0].sent[0];
    expect(request).toMatchObject({
      type: "tts.synthesize",
      text: "hello",
      config: {
        modelsDir: "/tmp/models",
        voiceTtsModel: "kokoro-en-v0_19",
      },
    });

    workers[0].respond(request, {
      audio: bufferToWorkerBytes(Buffer.from([1, 2, 3, 4])),
      format: "pcm;rate=24000",
    });

    const result = await pending;
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(result.format).toBe("pcm;rate=24000");
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("forwards STT session audio and transcript events through IPC", async () => {
    const { client, workers } = createClient();
    const provider = new WorkerBackedSpeechToTextProvider(client, "voiceStt");
    const session = provider.createSession({ logger: pino({ level: "silent" }) });

    const transcriptPromise = once(session as EventEmitter, "transcript");
    const committedPromise = once(session as EventEmitter, "committed");

    const connect = session.connect();
    const createRequest = workers[0].sent[0];
    expect(createRequest).toMatchObject({ type: "session.create", kind: "voiceStt" });
    workers[0].respond(createRequest, { requiredSampleRate: 16000 });
    await connect;

    session.appendPcm16(Buffer.from([9, 8, 7, 6]));
    await waitForMicrotasks();
    const appendRequest = workers[0].sent[1];
    expect(appendRequest).toMatchObject({
      type: "session.append",
      sessionId: createRequest.sessionId,
    });
    if (appendRequest.type !== "session.append") {
      throw new Error("Expected session.append request");
    }
    expect(Buffer.from(appendRequest.audio)).toEqual(Buffer.from([9, 8, 7, 6]));
    expect(workerBytesToBuffer(appendRequest.audio).byteOffset).toBe(0);

    session.commit();
    await waitForMicrotasks();
    expect(workers[0].sent[2]).toMatchObject({
      type: "session.commit",
      sessionId: createRequest.sessionId,
    });

    workers[0].emitWorkerMessage({
      type: "session.committed",
      sessionId: createRequest.sessionId,
      payload: { segmentId: "seg-1", previousSegmentId: null },
    });
    workers[0].emitWorkerMessage({
      type: "session.transcript",
      sessionId: createRequest.sessionId,
      payload: { segmentId: "seg-1", transcript: "hello", isFinal: true },
    });

    await expect(committedPromise).resolves.toEqual([
      { segmentId: "seg-1", previousSegmentId: null },
    ]);
    await expect(transcriptPromise).resolves.toEqual([
      { segmentId: "seg-1", transcript: "hello", isFinal: true },
    ]);
  });

  it("does not surface real IPC backpressure when replaying native-sized dictation frames", async () => {
    const workers: PausedIpcWorker[] = [];
    const client = new LocalSpeechWorkerClient({
      logger: pino({ level: "silent" }),
      config: {
        modelsDir: "/tmp/models",
        voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
        dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
        voiceTtsModel: "kokoro-en-v0_19",
      },
      requestTimeoutMs: 30_000,
      idleTtlMs: 30_000,
      forkWorker: () => {
        const worker = new PausedIpcWorker();
        workers.push(worker);
        return worker;
      },
    });
    const provider = new WorkerBackedSpeechToTextProvider(client, "dictationStt");
    const session = provider.createSession({ logger: pino({ level: "silent" }) });
    let observedError: Error | null = null;
    (session as EventEmitter).on("error", (error: Error) => {
      observedError = error;
    });

    try {
      await session.connect();
      const nativeFrame = Buffer.alloc(1024, 1);

      for (let seq = 0; seq < 480; seq += 1) {
        session.appendPcm16(nativeFrame);
      }
      session.commit();
      await waitForMicrotasks();

      expect(observedError?.message).not.toBe("Local speech worker IPC channel is not writable");
    } finally {
      client.shutdown();
      for (const worker of workers) {
        worker.kill();
      }
    }
  });

  it("logs worker exit details and includes actionable context in the surfaced error", async () => {
    const { logger, records } = createCapturingLogger();
    const workers: FakeLocalSpeechWorker[] = [];
    const client = new LocalSpeechWorkerClient({
      logger,
      config: {
        modelsDir: "/tmp/models",
        voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
        dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
        voiceTtsModel: "kokoro-en-v0_19",
      },
      forkWorker: () => {
        const worker = new FakeLocalSpeechWorker();
        workers.push(worker);
        return worker;
      },
    });
    const provider = new WorkerBackedSpeechToTextProvider(client, "dictationStt");
    const session = provider.createSession({ logger: pino({ level: "silent" }) });

    const connect = session.connect();
    connect.catch(() => {});
    // The start retries once on a fresh worker; both crash the same way.
    for (let index = 0; index < 2; index++) {
      await waitForMicrotasks();
      workers[index].emit("exit", null, "SIGABRT");
      workers[index].stderr.emit("data", "dyld: Library not loaded: libsherpa-onnx-c-api.dylib");
      workers[index].emit("close", null, "SIGABRT");
    }

    expect(workers).toHaveLength(2);
    await expect(connect).rejects.toMatchObject({ code: "speech_worker_exited" });
    await expect(connect).rejects.toThrow(
      "Local speech worker exited (signal SIGABRT) while handling session.create (dictationStt). Last stderr: dyld: Library not loaded: libsherpa-onnx-c-api.dylib",
    );
    const exitRecord = records.find((record) => record.msg === "Local speech worker exited");
    expect(exitRecord).toMatchObject({
      workerPid: 12345,
      signal: "SIGABRT",
      stderrTail: "dyld: Library not loaded: libsherpa-onnx-c-api.dylib",
      pendingRequests: [expect.objectContaining({ type: "session.create", kind: "dictationStt" })],
    });
  });

  it("does not log intentional shutdowns as worker crashes", async () => {
    const { logger, records } = createCapturingLogger();
    const workers: FakeLocalSpeechWorker[] = [];
    const client = new LocalSpeechWorkerClient({
      logger,
      config: {
        modelsDir: "/tmp/models",
        voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
        dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
        voiceTtsModel: "kokoro-en-v0_19",
      },
      forkWorker: () => {
        const worker = new FakeLocalSpeechWorker();
        workers.push(worker);
        return worker;
      },
    });

    const synthesize = client.synthesizeSpeech("hello");
    workers[0].respond(workers[0].sent[0], {
      audio: bufferToWorkerBytes(Buffer.from([1])),
      format: "pcm;rate=24000",
    });
    await synthesize;

    client.shutdown();
    workers[0].emit("close", null, "SIGTERM");

    expect(records.find((record) => record.msg === "Local speech worker exited")).toBeUndefined();
    expect(
      records.find((record) => record.msg === "Local speech worker closed after shutdown"),
    ).toMatchObject({
      workerPid: 12345,
      signal: "SIGTERM",
    });
  });

  it("forwards VAD session events through the shared worker", async () => {
    const { client, workers } = createClient();
    const provider = new WorkerBackedTurnDetectionProvider(client);
    const session = provider.createSession({ logger: pino({ level: "silent" }) });
    const startedPromise = once(session as EventEmitter, "speech_started");
    const stoppedPromise = once(session as EventEmitter, "speech_stopped");

    const connect = session.connect();
    const createRequest = workers[0].sent[0];
    expect(createRequest).toMatchObject({ type: "session.create", kind: "vad" });
    workers[0].respond(createRequest, { requiredSampleRate: 16000 });
    await connect;

    workers[0].emitWorkerMessage({
      type: "session.speech_started",
      sessionId: createRequest.sessionId,
    });
    workers[0].emitWorkerMessage({
      type: "session.speech_stopped",
      sessionId: createRequest.sessionId,
    });

    await expect(startedPromise).resolves.toEqual([]);
    await expect(stoppedPromise).resolves.toEqual([]);
  });

  it("kills an idle worker and respawns on later use", async () => {
    const { client, workers } = createClient({ idleTtlMs: 5 });

    const first = client.synthesizeSpeech("first");
    workers[0].respond(workers[0].sent[0], {
      audio: bufferToWorkerBytes(Buffer.from([1])),
      format: "pcm;rate=24000",
    });
    await first;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workers[0].kills).toBe(1);

    const second = client.synthesizeSpeech("second");
    expect(workers).toHaveLength(2);
    workers[1].respond(workers[1].sent[0], {
      audio: bufferToWorkerBytes(Buffer.from([2])),
      format: "pcm;rate=24000",
    });
    await second;
  });
});

describe("LocalSpeechWorkerClient session start recovery", () => {
  const timeouts = {
    requestTimeoutMs: 150,
    sessionStartWarmTimeoutMs: 40,
    sessionStartColdTimeoutMs: 40,
  };

  async function connectSession(
    client: LocalSpeechWorkerClient,
    worker: () => FakeLocalSpeechWorker,
  ) {
    const session = new WorkerBackedSpeechToTextProvider(client, "dictationStt").createSession({
      logger: pino({ level: "silent" }),
    });
    const connect = session.connect();
    const request = sentOfType(worker(), "session.create").at(-1)!;
    worker().respond(request, { requiredSampleRate: 16000 });
    await connect;
    return { session: session as unknown as EventEmitter, request };
  }

  it("replaces a worker whose session start hangs and succeeds on the retry", async () => {
    const { client, workers } = createClient(timeouts);
    const session = new WorkerBackedSpeechToTextProvider(client, "dictationStt").createSession({
      logger: pino({ level: "silent" }),
    });

    const connect = session.connect();
    await vi.waitFor(() => expect(workers).toHaveLength(2), { timeout: 500 });
    expect(workers[0].kills).toBe(1);
    const retry = sentOfType(workers[1], "session.create")[0];
    expect(retry.sessionId).toBe(sentOfType(workers[0], "session.create")[0].sessionId);
    workers[1].respond(retry, { requiredSampleRate: 16000 });

    await expect(connect).resolves.toBeUndefined();
  });

  it("gives up with speech_worker_timeout after one retry", async () => {
    const { client, workers } = createClient(timeouts);
    const session = new WorkerBackedSpeechToTextProvider(client, "dictationStt").createSession({
      logger: pino({ level: "silent" }),
    });

    await expect(session.connect()).rejects.toMatchObject({
      code: "speech_worker_timeout",
      message: "Local speech worker request timed out: session.create",
    });
    await sleep(100);
    expect(workers).toHaveLength(2);
    expect(workers.every((worker) => worker.kills === 1)).toBe(true);
  });

  it("starts promptly on a warm healthy worker", async () => {
    const { client, workers } = createClient(timeouts);
    await connectSession(client, () => workers[0]);
    await connectSession(client, () => workers[0]);

    expect(workers).toHaveLength(1);
    expect(workers[0].kills).toBe(0);
  });

  it("never kills a healthy slow worker for a start, and closes a start that answers late", async () => {
    const { client, workers } = createClient(timeouts);
    const active = await connectSession(client, () => workers[0]);
    const activeErrors: Error[] = [];
    active.session.on("error", (error: Error) => activeErrors.push(error));

    const late = new WorkerBackedSpeechToTextProvider(client, "dictationStt").createSession({
      logger: pino({ level: "silent" }),
    });
    const lateConnect = late.connect();
    lateConnect.catch(() => {});
    const lateRequest = sentOfType(workers[0], "session.create").at(-1)!;
    // The worker says nothing while the new start waits, but it has not been silent for the
    // whole request timeout, so it is slow, not dead.

    await expect(lateConnect).rejects.toMatchObject({ code: "speech_worker_timeout" });
    expect(workers).toHaveLength(1);
    expect(workers[0].kills).toBe(0);
    expect(activeErrors).toEqual([]);

    workers[0].respond(lateRequest, { requiredSampleRate: 16000 });
    await waitForMicrotasks();
    expect(sentOfType(workers[0], "session.close").map((request) => request.sessionId)).toEqual([
      lateRequest.sessionId,
    ]);
  });

  it("replaces a shared worker silent for the whole request timeout and fails its sessions", async () => {
    const { client, workers } = createClient(timeouts);
    const active = await connectSession(client, () => workers[0]);
    const activeErrors: Error[] = [];
    active.session.on("error", (error: Error) => activeErrors.push(error));
    // Nothing at all from the worker for longer than the request timeout.
    await sleep(timeouts.requestTimeoutMs + 20);

    const next = new WorkerBackedSpeechToTextProvider(client, "dictationStt").createSession({
      logger: pino({ level: "silent" }),
    });
    const nextConnect = next.connect();
    await vi.waitFor(() => expect(workers).toHaveLength(2), { timeout: 500 });
    workers[1].respond(sentOfType(workers[1], "session.create")[0], {
      requiredSampleRate: 16000,
    });

    await expect(nextConnect).resolves.toBeUndefined();
    expect(workers[0].kills).toBe(1);
    expect(activeErrors).toHaveLength(1);
    expect(activeErrors[0]).toMatchObject({ code: "speech_worker_timeout" });
  });

  it("keeps the whole start, retry included, within the start budget", async () => {
    const { client, workers } = createClient({
      ...timeouts,
      sessionStartWarmTimeoutMs: 100,
      sessionStartColdTimeoutMs: 100,
      sessionStartBudgetMs: 150,
    });
    const session = new WorkerBackedSpeechToTextProvider(client, "dictationStt").createSession({
      logger: pino({ level: "silent" }),
    });

    const startedAt = Date.now();
    await expect(session.connect()).rejects.toMatchObject({ code: "speech_worker_timeout" });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(workers).toHaveLength(2);
  });

  it("keeps requests alive while the worker reports progress and forwards it to the session", async () => {
    const { client, workers } = createClient({ ...timeouts, requestTimeoutMs: 60 });
    const active = await connectSession(client, () => workers[0]);
    const progress: unknown[] = [];
    active.session.on("progress", (event) => progress.push(event));

    const synthesize = client.synthesizeSpeech("queued behind decoding");
    const request = sentOfType(workers[0], "tts.synthesize")[0];
    // Decodes keep completing for well past the inactivity bound.
    for (let decoded = 1; decoded <= 5; decoded++) {
      await sleep(40);
      workers[0].emitWorkerMessage({
        type: "session.progress",
        sessionId: active.request.sessionId,
        payload: { decodedSegments: decoded, pendingSegments: 5 - decoded, pendingAudioMs: 0 },
      });
    }
    workers[0].respond(request, {
      audio: bufferToWorkerBytes(Buffer.from([1])),
      format: "pcm;rate=24000",
    });

    await expect(synthesize).resolves.toMatchObject({ format: "pcm;rate=24000" });
    expect(progress.at(-1)).toEqual({ decodedSegments: 5, pendingSegments: 0, pendingAudioMs: 0 });
  });

  it("replaces a worker whose recognizer wedged and fails the session with a typed code", async () => {
    const { client, workers } = createClient(timeouts);
    const active = await connectSession(client, () => workers[0]);
    const errors: Array<Error & { code?: string }> = [];
    active.session.on("error", (error: Error) => errors.push(error));

    // The worker reports the overrun decode, then exits because the recognizer is stuck.
    workers[0].emitWorkerMessage({
      type: "session.error",
      sessionId: active.request.sessionId,
      error: "Local speech decode did not finish within 120 s",
      code: "speech_worker_timeout",
    });
    workers[0].emit("close", 75, null);
    expect(errors.map((error) => error.code)).toEqual([
      "speech_worker_timeout",
      "speech_worker_exited",
    ]);

    await connectSession(client, () => workers[1]);
    expect(workers).toHaveLength(2);
  });
});
