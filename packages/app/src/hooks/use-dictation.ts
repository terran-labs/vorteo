import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getDeviceDictationRecordingStore } from "@/dictation/device-recording-store";
import { DictationStreamSender } from "@/dictation/dictation-stream-sender";
import { useDictationAudioSource } from "@/hooks/use-dictation-audio-source";
import { generateMessageId } from "@/types/stream";
import { AttemptGuard } from "@/utils/attempt-guard";
import {
  DURATION_TICK_MS,
  PCM_DICTATION_FORMAT,
  toError,
  type DictationStatus,
  type UseDictationOptions,
  type UseDictationResult,
} from "./use-dictation.shared";

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
  } = options;
  // Only composers that name their thread persist audio; tests inject their own store.
  const recordingStore =
    options.recordingStore ?? (recordingScope ? getDeviceDictationRecordingStore() : null);
  const recordingStoreRef = useRef(recordingStore);
  recordingStoreRef.current = recordingStore;
  /** Id of the stored copy of the audio in the sender, while it awaits a confirmed transcript. */
  const storedRecordingIdRef = useRef<string | null>(null);
  /** One automatic Retry when the connection returns after a failure while disconnected. */
  const autoRetryArmedRef = useRef(false);
  const retryRef = useRef<() => Promise<void>>(async () => undefined);

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
      setError(normalized.message);
      onErrorRef.current?.(normalized);
    },
    [setError],
  );

  const clearStreamingState = useCallback(() => {
    senderRef.current?.clearAll();
    latestPartialTranscriptRef.current = "";
    setPartialTranscript("");
  }, []);

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

  const handleStreamingTranscriptionSuccess = useCallback(
    (text: string, requestId: string) => {
      setIsProcessing(false);
      isProcessingRef.current = false;
      setDuration(0);
      setStatus("idle");

      const transcriptText =
        text.trim().length > 0 ? text.trim() : latestPartialTranscriptRef.current.trim();
      clearStreamingState();

      if (transcriptText) {
        onTranscriptRef.current?.(transcriptText, { requestId });
      }
      deleteStoredRecording();
    },
    [clearStreamingState, deleteStoredRecording, setStatus],
  );

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

  const audio = useDictationAudioSource({
    onPcmSegment: (audioData) => {
      senderRef.current?.enqueueSegment(audioData);
      const storedId = storedRecordingIdRef.current;
      if (storedId) {
        recordingStoreRef.current?.append(storedId, audioData);
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

  const startDictation = useCallback(async () => {
    if (
      actionGateRef.current.starting ||
      actionGateRef.current.confirming ||
      actionGateRef.current.cancelling
    ) {
      return;
    }
    if (isRecordingRef.current || isProcessingRef.current) {
      return;
    }
    // An unsent recording is never wiped by a new start: offer its Retry and Discard again.
    if (senderRef.current?.hasSegments()) {
      setStatus("failed");
      return;
    }
    const startAllowed = canStart ? canStart() : true;
    if (!startAllowed) {
      return;
    }

    actionGateRef.current.starting = true;
    setError(null);
    setPartialTranscript("");
    setDuration(0);
    setIsProcessing(false);
    setStatus("recording");
    clearStreamingState();
    autoRetryArmedRef.current = false;
    storedRecordingIdRef.current =
      recordingScope && recordingStoreRef.current
        ? recordingStoreRef.current.begin(recordingScope, PCM_DICTATION_FORMAT)
        : null;

    try {
      try {
        await audio.start();
      } catch (err) {
        await audio.stop().catch(() => undefined);
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
        return;
      }
      isRecordingRef.current = true;
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
    audio,
    canStart,
    clearStreamingState,
    client,
    deleteStoredRecording,
    enableDuration,
    recordingScope,
    reportError,
    setStatus,
    startDurationTracking,
    startNewStream,
    stopDurationTracking,
  ]);

  const cancelDictation = useCallback(async () => {
    attemptGuardRef.current.cancel();
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
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsProcessing(false);
      isProcessingRef.current = false;
      setStatus("idle");
      clearStreamingState();
      deleteStoredRecording();
      actionGateRef.current.cancelling = false;
    }
  }, [
    audio,
    clearStreamingState,
    deleteStoredRecording,
    reportError,
    setStatus,
    stopDurationTracking,
  ]);

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
        handleStreamingTranscriptionSuccess("", generateMessageId());
        return;
      }

      const transcriptText = await ensureFinalTranscript(finalSeq);
      attemptGuardRef.current.assertCurrent(attemptId);
      handleStreamingTranscriptionSuccess(transcriptText, generateMessageId());
    } catch (err) {
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
      // Close any half-open stream, then replay every segment from seq 0 on a new stream.
      sender.cancel();
      await sender.restartStream("retry");
      attemptGuardRef.current.assertCurrent(attemptId);
      const text = await ensureFinalTranscript(sender.getFinalSeq());
      attemptGuardRef.current.assertCurrent(attemptId);
      handleStreamingTranscriptionSuccess(text, generateMessageId());
    } catch (err) {
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

  // Offer back a recording this composer left without a confirmed transcript: after a reload,
  // an app kill, a Host restart or leaving the thread.
  useEffect(() => {
    const store = recordingStore;
    if (!store || !recordingScope) {
      return;
    }
    let cancelled = false;
    const offerBack = async () => {
      const pending = await store.findPending(recordingScope);
      if (cancelled || !pending || pending.segments.length === 0) {
        return;
      }
      const sender = senderRef.current;
      if (
        !sender ||
        sender.hasSegments() ||
        statusRef.current !== "idle" ||
        isRecordingRef.current ||
        isProcessingRef.current
      ) {
        return;
      }
      store.adopt(pending.recording.id);
      storedRecordingIdRef.current = pending.recording.id;
      sender.loadSegments(pending.segments);
      setError(null);
      setStatus("failed");
    };
    void offerBack();
    return () => {
      cancelled = true;
    };
  }, [recordingScope, recordingStore, setStatus]);

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

  useEffect(() => {
    const attemptGuard = attemptGuardRef.current;
    const audioStop = audioStopRef;
    return () => {
      attemptGuard.cancel();
      stopDurationTracking();
      void audioStop.current().catch(() => undefined);
      senderRef.current?.dispose();
      // Leaving the composer keeps the stored audio for the next mount to offer back.
      const storedId = storedRecordingIdRef.current;
      if (storedId) {
        recordingStoreRef.current?.release(storedId);
      }
    };
  }, [stopDurationTracking]);

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
    reset,
  };
}

export type {
  DictationStatus,
  UseDictationOptions,
  UseDictationResult,
} from "./use-dictation.shared";
