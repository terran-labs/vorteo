import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getDeviceDictationRecordingStore } from "@/dictation/device-recording-store";
import { DictationStreamSender } from "@/dictation/dictation-stream-sender";
import { decodedSegmentBytes, PCM_BYTES_PER_SECOND } from "@/dictation/recording-wav";
import {
  prepareDictationExport,
  shareDictationExport,
  type PreparedDictationExport,
} from "@/dictation/recording-export";
import type {
  DictationRecordingPersistence,
  DictationRecordingStore,
} from "@/dictation/recording-store";
import { useDictationAudioSource } from "@/hooks/use-dictation-audio-source";
import { generateMessageId } from "@/types/stream";
import { AttemptGuard } from "@/utils/attempt-guard";
import { toDictationErrorMessage } from "@/utils/error-messages";
import {
  DURATION_TICK_MS,
  PCM_DICTATION_FORMAT,
  SHORT_CAPTURE_DISCARD_MS,
  toError,
  type DictationCancelOptions,
  type SaveAudioState,
  type DictationStatus,
  type UseDictationOptions,
  type UseDictationResult,
} from "./use-dictation.shared";

/**
 * Recordings longer than this are turned into a Save audio file only when the owner presses it,
 * so an automatic background build cannot hold hundreds of megabytes.
 */
const BACKGROUND_EXPORT_MAX_SECONDS = 20 * 60;
/** Longest a closing composer waits for its microphone stop before handing its audio over. */
const HANDOVER_STOP_WAIT_MS = 5_000;
/** A notice still waiting for its writes after this long says the recording is not saved. */
const SAVING_STALL_MS = 10_000;

function recordingDurationSeconds(segments: readonly string[]): number {
  let bytes = 0;
  for (const segment of segments) {
    bytes += decodedSegmentBytes(segment);
  }
  return bytes / PCM_BYTES_PER_SECOND;
}

function resolveRecordingStore(
  injected: DictationRecordingStore | null | undefined,
  recordingScope: string | undefined,
): DictationRecordingStore | null {
  if (injected !== undefined) {
    return injected;
  }
  return recordingScope ? getDeviceDictationRecordingStore() : null;
}

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const { t } = useTranslation();
  const {
    client,
    onTranscript,
    onPartialTranscript,
    onError,
    onPermanentFailure,
    canStart,
    canConfirm,
    enableDuration = false,
    recordingScope,
    recordingServerId,
  } = options;
  /**
   * The thread this instance serves, fixed at mount. The composer is keyed by recording scope, so
   * a thread switch unmounts this instance and mounts a new one; no state ever crosses threads.
   */
  const scope = useRef(recordingScope).current;
  if (recordingScope !== scope && process.env.NODE_ENV !== "production") {
    console.error(
      "[useDictation] The recording scope changed without a remount; key the composer by scope.",
    );
  }
  // Only composers that name their thread persist audio; null disables device storage.
  const recordingStore = resolveRecordingStore(options.recordingStore, scope);
  const recordingStoreRef = useRef(recordingStore);
  recordingStoreRef.current = recordingStore;
  const recordingServerIdRef = useRef(recordingServerId);
  recordingServerIdRef.current = recordingServerId;
  /** Id of the stored copy of the audio in the sender, while it awaits a confirmed transcript. */
  const storedRecordingIdRef = useRef<string | null>(null);
  /** One automatic Retry when the connection returns after a failure while disconnected. */
  const autoRetryArmedRef = useRef(false);
  const retryRef = useRef<() => Promise<void>>(async () => undefined);
  const captureStartedAtRef = useRef(0);
  /** False once unmounted; audio that arrives after (a stop's tail) must not touch React state. */
  const mountedRef = useRef(true);
  /**
   * Identity of the audio in the sender. Changes whenever the sender holds a different recording
   * (a new capture, a restore, a clear), so nothing prepared for one recording is used for
   * another.
   */
  const audioTokenRef = useRef(0);
  /** Bumped on every change to the sender's audio, so effects keyed on it rerun. */
  const [audioVersion, setAudioVersion] = useState(0);
  /** When the notice started reading "saving"; a write that never lands falls back to not saved. */
  const savingSinceRef = useRef<number | null>(null);
  const markAudioChanged = useCallback((newRecording: boolean) => {
    if (newRecording) {
      audioTokenRef.current += 1;
      savingSinceRef.current = null;
    }
    if (mountedRef.current) {
      setAudioVersion((version) => version + 1);
    }
  }, []);

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatusState] = useState<DictationStatus>("idle");
  const statusRef = useRef<DictationStatus>("idle");
  const setStatus = useCallback((next: DictationStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  const latestPartialTranscriptRef = useRef("");

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const onPartialTranscriptRef = useRef(onPartialTranscript);
  useEffect(() => {
    onPartialTranscriptRef.current = onPartialTranscript;
  }, [onPartialTranscript]);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const onPermanentFailureRef = useRef(onPermanentFailure);
  useEffect(() => {
    onPermanentFailureRef.current = onPermanentFailure;
  }, [onPermanentFailure]);

  /** When the audio in the sender was first captured; names the saved file. */
  const recordingCreatedAtRef = useRef(0);
  /** Format of the audio in the sender; a recovered recording carries its stored format. */
  const recordingFormatRef = useRef(PCM_DICTATION_FORMAT);
  /** The Save audio file, built when the failed state appears so the press can share at once. */
  const preparedExportRef = useRef<{ token: number; prepared: PreparedDictationExport } | null>(
    null,
  );
  /**
   * Save audio progress the overlay shows: "preparing" while a press waits for its file (the
   * button is disabled), "ready" when that file finished after the press, whose gesture can no
   * longer open the share sheet, so the owner presses again.
   */
  const [saveAudioState, setSaveAudioState] = useState<SaveAudioState>("idle");
  /** The one build in flight for a recording; presses and the background build share it. */
  const preparingExportRef = useRef<{
    token: number;
    promise: Promise<PreparedDictationExport | null>;
  } | null>(null);
  const [recordingPersistence, setRecordingPersistence] =
    useState<DictationRecordingPersistence | null>(null);

  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  const isRecordingActive = useCallback(() => isRecordingRef.current, []);

  const isProcessingRef = useRef(isProcessing);
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // duration is used for UI only; no need to mirror into a ref.

  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptGuardRef = useRef(new AttemptGuard());
  const actionGateRef = useRef<{ starting: boolean; confirming: boolean; cancelling: boolean }>({
    starting: false,
    confirming: false,
    cancelling: false,
  });

  const senderRef = useRef<DictationStreamSender | null>(null);
  if (!senderRef.current) {
    senderRef.current = new DictationStreamSender({
      client,
      format: PCM_DICTATION_FORMAT,
      createDictationId: generateMessageId,
    });
  }
  useEffect(() => {
    senderRef.current?.setClient(client);
  }, [client]);

  const stopDurationTracking = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const startDurationTracking = useCallback(() => {
    if (!enableDuration) {
      return;
    }
    if (durationIntervalRef.current) {
      return;
    }
    durationIntervalRef.current = setInterval(() => {
      setDuration((prev) => prev + 1);
    }, DURATION_TICK_MS);
  }, [enableDuration]);

  useEffect(() => {
    if (!enableDuration) {
      stopDurationTracking();
      setDuration(0);
    }
  }, [enableDuration, stopDurationTracking]);

  const reportError = useCallback(
    (err: unknown, context?: string) => {
      const normalized = toError(err);
      if (normalized.name === "AttemptCancelledError") {
        return;
      }
      if (context) {
        console.error(`[useDictation] ${context}`, normalized);
      } else {
        console.error("[useDictation]", normalized);
      }
      setError(toDictationErrorMessage(normalized));
      onErrorRef.current?.(normalized);
    },
    [setError],
  );

  const clearStreamingState = useCallback(() => {
    senderRef.current?.clearAll();
    latestPartialTranscriptRef.current = "";
    setPartialTranscript("");
    markAudioChanged(true);
  }, [markAudioChanged]);

  /** Deletes the device copy. Call only after a transcript is applied or the owner discards. */
  const deleteStoredRecording = useCallback(() => {
    const id = storedRecordingIdRef.current;
    storedRecordingIdRef.current = null;
    autoRetryArmedRef.current = false;
    if (id) {
      void recordingStoreRef.current?.delete(id);
    }
  }, []);

  const startNewStream = useCallback(async (reason: string) => {
    await senderRef.current?.restartStream(reason);
  }, []);

  const ensureFinalTranscript = useCallback(async (finalSeq: number): Promise<string> => {
    const result = await senderRef.current!.finish(finalSeq);
    return result.text;
  }, []);

  useEffect(() => {
    if (!client) {
      return;
    }
    return client.subscribeConnectionStatus((next) => {
      if (next.status !== "connected") {
        return;
      }
      if (autoRetryArmedRef.current && statusRef.current === "failed") {
        autoRetryArmedRef.current = false;
        void retryRef.current();
        return;
      }
      if (!isRecordingRef.current) {
        return;
      }
      void startNewStream("reconnect").catch((err) => {
        reportError(err, "Failed to restart dictation stream after reconnect");
      });
    });
  }, [client, reportError, startNewStream]);

  useEffect(() => {
    if (!client) {
      return;
    }
    return client.on("dictation_stream_partial", (message) => {
      if (message.type !== "dictation_stream_partial") {
        return;
      }
      const activeDictationId = senderRef.current?.getDictationId();
      if (!activeDictationId) {
        return;
      }
      if (message.payload.dictationId !== activeDictationId) {
        return;
      }
      const next = message.payload.text ?? "";
      latestPartialTranscriptRef.current = next;
      setPartialTranscript(next);
      onPartialTranscriptRef.current?.(next, { requestId: generateMessageId() });
    });
  }, [client]);

  const handleDictationFailure = useCallback(
    (failure: unknown) => {
      const normalized = toError(failure);
      const failureId = generateMessageId();
      stopDurationTracking();
      setIsProcessing(false);
      isProcessingRef.current = false;
      isRecordingRef.current = false;
      setIsRecording(false);

      // Captured audio is never dropped by a failure: it waits for Retry or Discard.
      if (senderRef.current?.hasSegments()) {
        setStatus("failed");
        if (!client?.isConnected) {
          autoRetryArmedRef.current = true;
        }
        onPermanentFailureRef.current?.(normalized, { requestId: failureId });
      } else {
        setStatus("idle");
        deleteStoredRecording();
      }

      reportError(normalized, "Failed to complete dictation");
    },
    [client, deleteStoredRecording, reportError, setStatus, stopDurationTracking],
  );

  /**
   * Applies a final transcript. Only a non-empty final text counts as confirmation and deletes
   * the stored audio; an empty final keeps the audio and offers Retry. A partial transcript is
   * never used in place of the final, since it may be missing the end of the recording.
   */
  const handleStreamingTranscriptionSuccess = useCallback(
    (text: string, requestId: string) => {
      const transcriptText = text.trim();
      if (!transcriptText) {
        handleDictationFailure(new Error(t("message.dictation.failedRetry")));
        return;
      }
      setIsProcessing(false);
      isProcessingRef.current = false;
      setDuration(0);
      setStatus("idle");
      clearStreamingState();
      onTranscriptRef.current?.(transcriptText, { requestId });
      deleteStoredRecording();
    },
    [clearStreamingState, deleteStoredRecording, handleDictationFailure, setStatus, t],
  );

  /** Ends a confirm that captured no audio at all; there is nothing to keep or transcribe. */
  const finishWithoutAudio = useCallback(() => {
    setIsProcessing(false);
    isProcessingRef.current = false;
    setDuration(0);
    setStatus("idle");
    clearStreamingState();
    deleteStoredRecording();
  }, [clearStreamingState, deleteStoredRecording, setStatus]);

  const audio = useDictationAudioSource({
    onPcmSegment: (audioData) => {
      // One instance serves one thread, so every segment, including a tail that arrives after
      // unmount, belongs to this instance's recording.
      senderRef.current?.enqueueSegment(audioData);
      const storedId = storedRecordingIdRef.current;
      if (storedId) {
        recordingStoreRef.current?.append(storedId, audioData);
      }
      if (!isRecordingRef.current && mountedRef.current) {
        // Audio that arrived after capture ended (a stop's tail) changes what Save audio and the
        // notice describe, so they refresh.
        markAudioChanged(false);
        if (!isProcessingRef.current && statusRef.current === "idle") {
          // It still waits for Retry or Discard.
          setStatus("failed");
        }
      }
    },
    onError: (err) => {
      onErrorRef.current?.(err);
    },
    onInterruption: () => {
      try {
        senderRef.current?.cancel();
      } catch {
        // no-op
      }
      handleDictationFailure(new Error("Dictation was interrupted by another audio source."));
    },
  });
  const audioStopRef = useRef(audio.stop);
  useEffect(() => {
    audioStopRef.current = audio.stop;
  }, [audio.stop]);

  /** Whether a start must not proceed. */
  const isStartBlocked = useCallback((): boolean => {
    if (isRecordingRef.current || isProcessingRef.current) {
      return true;
    }
    // An unsent recording is never wiped by a new start: offer its Retry and Discard again.
    if (senderRef.current?.hasSegments()) {
      setStatus("failed");
      return true;
    }
    return false;
  }, [setStatus]);

  /** Prepares a new capture: replaces the empty stored id and begins a stored recording. */
  const beginCapture = useCallback(() => {
    // A stored id with no audio in memory is an empty recording (memory always holds at least
    // what the device holds); delete it rather than leave an empty row behind.
    if (storedRecordingIdRef.current) {
      void recordingStoreRef.current?.delete(storedRecordingIdRef.current);
      storedRecordingIdRef.current = null;
    }
    setError(null);
    setPartialTranscript("");
    setDuration(0);
    setIsProcessing(false);
    setStatus("recording");
    clearStreamingState();
    autoRetryArmedRef.current = false;
    storedRecordingIdRef.current =
      scope && recordingStoreRef.current
        ? recordingStoreRef.current.begin(scope, PCM_DICTATION_FORMAT, recordingServerId)
        : null;
    recordingCreatedAtRef.current = Date.now();
    recordingFormatRef.current = PCM_DICTATION_FORMAT;
  }, [clearStreamingState, recordingServerId, scope, setStatus]);

  /** Opens the microphone; false when it failed or this composer closed meanwhile. */
  const openMicrophone = useCallback(async (): Promise<boolean> => {
    try {
      await audio.start();
    } catch (err) {
      await audio.stop().catch(() => undefined);
      if (!mountedRef.current) {
        return false;
      }
      stopDurationTracking();
      isRecordingRef.current = false;
      setIsRecording(false);
      if (senderRef.current?.hasSegments()) {
        setStatus("failed");
      } else {
        setStatus("idle");
        deleteStoredRecording();
      }
      reportError(err, "Failed to start dictation");
      return false;
    }
    if (!mountedRef.current) {
      // Closed while the microphone opened; the unmount hands over anything captured.
      await audio.stop().catch(() => undefined);
      return false;
    }
    return true;
  }, [audio, deleteStoredRecording, reportError, setStatus, stopDurationTracking]);

  const startDictation = useCallback(async () => {
    if (
      actionGateRef.current.starting ||
      actionGateRef.current.confirming ||
      actionGateRef.current.cancelling
    ) {
      return;
    }
    if (isStartBlocked()) {
      return;
    }
    const startAllowed = canStart ? canStart() : true;
    if (!startAllowed) {
      return;
    }

    actionGateRef.current.starting = true;
    try {
      // The audio source's start waits for every microphone stop in flight, including a
      // previous composer instance's, before it opens a new capture.
      beginCapture();
      if (!(await openMicrophone())) {
        return;
      }
      isRecordingRef.current = true;
      captureStartedAtRef.current = Date.now();
      setIsRecording(true);
      if (enableDuration) {
        startDurationTracking();
      }
      if (client?.isConnected) {
        // A failed stream start leaves the microphone running and the audio buffered: confirm
        // starts a new stream, and a failure there offers Retry. It never resets to idle.
        await startNewStream("start").catch((err: unknown) => {
          reportError(err, "Failed to start dictation stream");
        });
      }
    } finally {
      actionGateRef.current.starting = false;
    }
  }, [
    beginCapture,
    canStart,
    client,
    enableDuration,
    isStartBlocked,
    openMicrophone,
    reportError,
    startDurationTracking,
    startNewStream,
  ]);

  const cancelDictation = useCallback(
    async (cancelOptions?: DictationCancelOptions) => {
      attemptGuardRef.current.cancel();
      // A press of the Cancel button on a short capture is a discard; anything longer, and every
      // other cancel path, keeps the audio for Retry or Discard.
      const discardShortCapture =
        cancelOptions?.source === "button" &&
        isRecordingRef.current &&
        Date.now() - captureStartedAtRef.current < SHORT_CAPTURE_DISCARD_MS;
      if (actionGateRef.current.cancelling) {
        return;
      }
      if (!isRecordingRef.current && !isProcessingRef.current) {
        return;
      }
      actionGateRef.current.cancelling = true;
      stopDurationTracking();
      setDuration(0);
      setError(null);

      try {
        try {
          senderRef.current?.cancel();
        } catch {
          // no-op
        }
        await audio.stop();
      } catch (err) {
        reportError(err, "Failed to cancel dictation");
      } finally {
        // A composer that closed during the stop hands its audio over on unmount instead.
        if (mountedRef.current) {
          isRecordingRef.current = false;
          setIsRecording(false);
          setIsProcessing(false);
          isProcessingRef.current = false;
          // Cancel stops capture and the stream but keeps the audio for Retry or Discard,
          // except a Cancel button press on a short capture.
          if (senderRef.current?.hasSegments() && !discardShortCapture) {
            setStatus("failed");
          } else {
            setStatus("idle");
            clearStreamingState();
            deleteStoredRecording();
          }
        }
        actionGateRef.current.cancelling = false;
      }
    },
    [
      audio,
      clearStreamingState,
      deleteStoredRecording,
      reportError,
      setStatus,
      stopDurationTracking,
    ],
  );

  const confirmDictation = useCallback(async () => {
    if (actionGateRef.current.confirming) {
      return;
    }
    if (!isRecordingRef.current || isProcessingRef.current) {
      return;
    }
    const confirmAllowed = canConfirm ? canConfirm() : true;
    if (!confirmAllowed) {
      return;
    }

    actionGateRef.current.confirming = true;
    setError(null);
    stopDurationTracking();
    setIsProcessing(true);
    isProcessingRef.current = true;

    const attemptId = attemptGuardRef.current.next();

    try {
      await audio.stop();
      attemptGuardRef.current.assertCurrent(attemptId);

      setStatus("uploading");
      isRecordingRef.current = false;
      setIsRecording(false);

      const finalSeq = senderRef.current?.getFinalSeq() ?? -1;
      if (finalSeq < 0) {
        finishWithoutAudio();
        return;
      }

      const transcriptText = await ensureFinalTranscript(finalSeq);
      attemptGuardRef.current.assertCurrent(attemptId);
      handleStreamingTranscriptionSuccess(transcriptText, generateMessageId());
    } catch (err) {
      // A cancel, Discard or thread switch during the wait owns the state now.
      if (!attemptGuardRef.current.isCurrent(attemptId)) {
        return;
      }
      if (err instanceof Error && err.name === "AttemptCancelledError") {
        return;
      }
      handleDictationFailure(err);
    } finally {
      actionGateRef.current.confirming = false;
    }
  }, [
    audio,
    canConfirm,
    handleDictationFailure,
    handleStreamingTranscriptionSuccess,
    finishWithoutAudio,
    setStatus,
    stopDurationTracking,
    ensureFinalTranscript,
  ]);

  const retryFailedDictation = useCallback(async () => {
    const sender = senderRef.current;
    if (!sender?.hasSegments() || isProcessingRef.current || isRecordingRef.current) {
      return;
    }
    if (!client?.isConnected) {
      // Nothing can reach the Host now. Keep the audio and resend once the connection returns.
      autoRetryArmedRef.current = true;
      setStatus("failed");
      reportError(
        new Error(t("common.errors.daemonClientDisconnected")),
        "Dictation retry waiting for connection",
      );
      return;
    }
    autoRetryArmedRef.current = false;
    setError(null);
    setStatus("uploading");
    setIsProcessing(true);
    isProcessingRef.current = true;
    const attemptId = attemptGuardRef.current.next();

    try {
      // Cancel every stream the server may still be transcribing, including one whose finish
      // timed out here, then replay every segment from seq 0 on a new stream.
      await sender.cancelOpenStreams();
      attemptGuardRef.current.assertCurrent(attemptId);
      await sender.restartStream("retry");
      attemptGuardRef.current.assertCurrent(attemptId);
      const text = await ensureFinalTranscript(sender.getFinalSeq());
      attemptGuardRef.current.assertCurrent(attemptId);
      handleStreamingTranscriptionSuccess(text, generateMessageId());
    } catch (err) {
      // A cancel, Discard or thread switch during the wait owns the state now.
      if (!attemptGuardRef.current.isCurrent(attemptId)) {
        return;
      }
      if (err instanceof Error && err.name === "AttemptCancelledError") {
        return;
      }
      handleDictationFailure(err);
    }
  }, [
    client,
    ensureFinalTranscript,
    handleDictationFailure,
    handleStreamingTranscriptionSuccess,
    reportError,
    setStatus,
    t,
  ]);
  retryRef.current = retryFailedDictation;

  const reportSaveFailure = useCallback(
    (err: unknown) => {
      console.error("[useDictation] Failed to save dictation audio", err);
      onErrorRef.current?.(new Error(t("message.dictation.saveFailed")));
    },
    [t],
  );

  const prepareExport = useCallback((): Promise<PreparedDictationExport> => {
    const segments = senderRef.current?.getSegments() ?? [];
    // Memory always holds at least what the device holds, so the file is built from memory.
    return prepareDictationExport(
      segments,
      recordingCreatedAtRef.current || Date.now(),
      recordingFormatRef.current,
    );
  }, []);

  /** The prepared file, only if it was built from exactly the audio the sender holds now. */
  const currentPreparedExport = useCallback((): PreparedDictationExport | null => {
    const entry = preparedExportRef.current;
    const segmentCount = senderRef.current?.getSegmentCount() ?? 0;
    if (
      entry &&
      entry.token === audioTokenRef.current &&
      entry.prepared.segmentCount === segmentCount
    ) {
      return entry.prepared;
    }
    return null;
  }, []);

  const keepPreparedExport = useCallback((token: number, prepared: PreparedDictationExport) => {
    if (
      token !== audioTokenRef.current ||
      senderRef.current?.getSegmentCount() !== prepared.segmentCount
    ) {
      // The audio changed while the file was built; never keep it for another recording.
      prepared.release();
      return false;
    }
    preparedExportRef.current?.prepared.release();
    preparedExportRef.current = { token, prepared };
    return true;
  }, []);

  /**
   * Builds the Save audio file for the current recording once. Concurrent callers for the same
   * recording share the build, so presses during a long build never start a second one.
   */
  const prepareOnce = useCallback((): Promise<PreparedDictationExport | null> => {
    const token = audioTokenRef.current;
    const inFlight = preparingExportRef.current;
    if (inFlight && inFlight.token === token) {
      return inFlight.promise;
    }
    const promise = prepareExport()
      .then((prepared) => (keepPreparedExport(token, prepared) ? prepared : null))
      .finally(() => {
        if (preparingExportRef.current?.promise === promise) {
          preparingExportRef.current = null;
        }
      });
    preparingExportRef.current = { token, promise };
    return promise;
  }, [keepPreparedExport, prepareExport]);

  const saveFailedRecording = useCallback((): Promise<void> => {
    const segmentCount = senderRef.current?.getSegmentCount() ?? 0;
    if (segmentCount === 0) {
      return Promise.resolve();
    }
    const token = audioTokenRef.current;
    const failedForThisRecording = (err: unknown) => {
      // A thread switch made the result irrelevant; never report it under another recording.
      if (token === audioTokenRef.current) {
        setSaveAudioState("idle");
        reportSaveFailure(err);
      }
    };
    const ready = currentPreparedExport();
    if (ready) {
      // Prepared from this exact audio: share() runs inside this press, as iOS requires.
      setSaveAudioState("idle");
      return shareDictationExport(ready).then(() => undefined, failedForThisRecording);
    }
    // Not ready. This press's gesture will be gone by the time the file exists, so it does not
    // share: it builds (or joins the build in flight) and then asks for a second press.
    setSaveAudioState("preparing");
    const prepareForNextPress = async () => {
      try {
        const prepared = await prepareOnce();
        if (token !== audioTokenRef.current) {
          return;
        }
        if (!prepared) {
          throw new Error("The recording changed while its audio file was prepared");
        }
        setSaveAudioState("ready");
      } catch (err) {
        failedForThisRecording(err);
      }
    };
    return prepareForNextPress();
  }, [currentPreparedExport, prepareOnce, reportSaveFailure]);

  // Build the Save audio file in the background while the failed state shows, keyed to the
  // audio's identity so a thread switch or a late tail rebuilds it. Recordings longer than the
  // background limit are built only when Save audio is pressed, to bound memory. The file is
  // dropped once the recording is sent, discarded or recording starts again.
  useEffect(() => {
    setSaveAudioState("idle");
    if (status !== "failed") {
      preparedExportRef.current?.prepared.release();
      preparedExportRef.current = null;
      return;
    }
    if (currentPreparedExport()) {
      return;
    }
    preparedExportRef.current?.prepared.release();
    preparedExportRef.current = null;
    const segments = senderRef.current?.getSegments() ?? [];
    if (
      segments.length === 0 ||
      recordingDurationSeconds(segments) > BACKGROUND_EXPORT_MAX_SECONDS
    ) {
      return;
    }
    prepareOnce().catch((err: unknown) => {
      console.warn("[useDictation] Could not prepare dictation audio for saving", err);
    });
  }, [audioVersion, currentPreparedExport, prepareOnce, status]);

  const discardFailedDictation = useCallback(() => {
    attemptGuardRef.current.cancel();
    senderRef.current?.cancel();
    setIsProcessing(false);
    isProcessingRef.current = false;
    setDuration(0);
    setStatus("idle");
    setError(null);
    clearStreamingState();
    deleteStoredRecording();
  }, [clearStreamingState, deleteStoredRecording, setStatus]);

  // Offer back this thread's unsent recording: one left by a previous composer for the thread
  // (handed over on unmount), or one on the device after a reload, an app kill or a Host restart.
  // The device store is the only restore path.
  useEffect(() => {
    const store = recordingStore;
    if (!store || !scope) {
      return;
    }
    let cancelled = false;
    const offerBack = async () => {
      const pending = await store.findPending(scope);
      if (!pending) {
        return;
      }
      const current = senderRef.current;
      if (
        cancelled ||
        !current ||
        current.hasSegments() ||
        statusRef.current !== "idle" ||
        isRecordingRef.current ||
        isProcessingRef.current
      ) {
        if (pending.fromMemory) {
          // Never drop memory-only audio: hand it back for the next mount.
          store.retainInMemory(scope, {
            segments: pending.segments,
            createdAt: pending.recording.createdAt,
            format: pending.recording.format,
            storedId:
              pending.recording.incomplete && !pending.recording.id.startsWith("memory-")
                ? pending.recording.id
                : null,
            serverId: pending.recording.serverId,
          });
        } else {
          store.release(pending.recording.id);
        }
        return;
      }
      storedRecordingIdRef.current = pending.recording.id;
      recordingCreatedAtRef.current = pending.recording.createdAt;
      recordingFormatRef.current = pending.recording.format;
      current.loadSegments(pending.segments);
      markAudioChanged(true);
      setError(null);
      setStatus("failed");
    };
    void offerBack();
    return () => {
      cancelled = true;
    };
  }, [markAudioChanged, recordingStore, scope, setStatus]);

  // The Host a recording is delivered to is the one stamped on it: a draft that switches Host
  // restamps the recording it holds, so removing a Host deletes exactly its recordings.
  useEffect(() => {
    const id = storedRecordingIdRef.current;
    if (id && recordingServerId) {
      recordingStoreRef.current?.restamp(id, recordingServerId);
    }
  }, [recordingServerId, audioVersion]);

  const reset = useCallback(() => {
    setIsRecording(false);
    isRecordingRef.current = false;
    setIsProcessing(false);
    isProcessingRef.current = false;
    stopDurationTracking();
    setDuration(0);
    setError(null);
    setStatus("idle");
    clearStreamingState();
    // The device copy stays; the next mount offers it back.
    const storedId = storedRecordingIdRef.current;
    storedRecordingIdRef.current = null;
    if (storedId) {
      recordingStoreRef.current?.release(storedId);
    }
  }, [clearStreamingState, setStatus, stopDurationTracking]);

  // Unmount, including a thread switch (the composer is keyed by scope): stop capture, let the
  // stop's last audio land in this instance's own recording, then leave the recording for the
  // next mount. Audio not wholly on the device is handed to the store in memory.
  useEffect(() => {
    mountedRef.current = true;
    const attemptGuard = attemptGuardRef.current;
    const audioStop = audioStopRef;
    return () => {
      mountedRef.current = false;
      attemptGuard.cancel();
      stopDurationTracking();
      const store = recordingStoreRef.current;
      const finishHandover = store && scope ? store.beginHandover(scope) : null;
      const handOver = async () => {
        // A stop that never settles must not hold the recording back from the next mount: hand
        // over after a bounded wait with whatever audio has arrived.
        let stopTimer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          audioStop.current().catch(() => undefined),
          new Promise<void>((resolve) => {
            stopTimer = setTimeout(resolve, HANDOVER_STOP_WAIT_MS);
          }),
        ]);
        if (stopTimer) {
          clearTimeout(stopTimer);
        }
        const sender = senderRef.current;
        const storedId = storedRecordingIdRef.current;
        try {
          if (store && scope && sender?.hasSegments()) {
            await store.flush();
            const count = sender.getSegmentCount();
            if (store.persistence(storedId, count) !== "stored") {
              store.retainInMemory(scope, {
                segments: sender.getSegments(),
                createdAt: recordingCreatedAtRef.current || Date.now(),
                format: recordingFormatRef.current,
                storedId: storedId && !storedId.startsWith("memory-") ? storedId : null,
                serverId: recordingServerIdRef.current,
              });
              return;
            }
          }
          if (storedId) {
            store?.release(storedId);
          }
        } finally {
          sender?.dispose();
          finishHandover?.();
        }
      };
      void handOver();
    };
  }, [scope, stopDurationTracking]);

  // Keep the notice line honest: recompute where the unsent audio lives whenever the dictation
  // state changes or the store reports progress or a failure. "stored" requires every segment in
  // memory to be on the device. Owner-facing storage toasts come from one app-level listener.
  // A write that never lands (a hung IndexedDB) must not leave the notice silent forever: after
  // SAVING_STALL_MS of "saving" it says the recording is not saved.
  useEffect(() => {
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      const segmentCount = senderRef.current?.getSegmentCount() ?? 0;
      const store = recordingStoreRef.current;
      let persistence: DictationRecordingPersistence | null =
        segmentCount > 0
          ? (store?.persistence(storedRecordingIdRef.current, segmentCount) ?? "memory-only")
          : null;
      if (persistence === "saving") {
        savingSinceRef.current ??= Date.now();
        const waited = Date.now() - savingSinceRef.current;
        if (waited >= SAVING_STALL_MS) {
          persistence = "memory-only";
        } else if (!stallTimer) {
          stallTimer = setTimeout(() => {
            stallTimer = null;
            refresh();
          }, SAVING_STALL_MS - waited);
        }
      } else {
        savingSinceRef.current = null;
      }
      setRecordingPersistence(persistence);
    };
    refresh();
    const unsubscribe = recordingStore?.subscribe(refresh);
    return () => {
      unsubscribe?.();
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
    };
  }, [audioVersion, recordingStore, status]);

  return {
    isRecording,
    isRecordingActive,
    isProcessing,
    partialTranscript,
    volume: audio.volume,
    duration,
    error,
    status: status === "recording" && audio.isPaused ? "paused" : status,
    startDictation,
    cancelDictation,
    confirmDictation,
    retryFailedDictation,
    discardFailedDictation,
    saveFailedRecording,
    recordingPersistence,
    saveAudioState,
    reset,
  };
}

export type {
  DictationStatus,
  UseDictationOptions,
  UseDictationResult,
} from "./use-dictation.shared";
