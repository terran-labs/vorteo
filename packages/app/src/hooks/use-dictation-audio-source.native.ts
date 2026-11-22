import { useCallback, useEffect, useRef } from "react";
import { Buffer } from "buffer";
import { useState } from "react";

import { createAudioEngine } from "@/audio";

import type {
  DictationAudioSource,
  DictationAudioSourceConfig,
} from "./use-dictation-audio-source.types";

export function useDictationAudioSource(config: DictationAudioSourceConfig): DictationAudioSource {
  const onPcmSegmentRef = useRef(config.onPcmSegment);
  const onErrorRef = useRef(config.onError);
  const onInterruptionRef = useRef(config.onInterruption);
  const [volume, setVolume] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const engineRef = useRef<ReturnType<typeof createAudioEngine> | null>(null);

  const getOrCreateEngine = useCallback(() => {
    if (engineRef.current) {
      return engineRef.current;
    }

    engineRef.current = createAudioEngine(
      {
        onCaptureData: (pcm) => {
          onPcmSegmentRef.current(Buffer.from(pcm).toString("base64"));
        },
        onVolumeLevel: (level) => {
          setVolume(level);
        },
        onError: (error) => {
          onErrorRef.current?.(error);
        },
        onInterruption: () => {
          onInterruptionRef.current?.();
        },
        onCaptureAvailabilityChange: (available) => setIsPaused(!available),
      },
      { captureMode: "dictation" },
    );
    return engineRef.current;
  }, []);

  useEffect(() => {
    onPcmSegmentRef.current = config.onPcmSegment;
    onErrorRef.current = config.onError;
    onInterruptionRef.current = config.onInterruption;
  }, [config.onPcmSegment, config.onError, config.onInterruption]);

  // Concurrent callers share one in-flight stop, so a stop that overlaps another (unmount, a
  // thread switch during cancel or confirm) cannot deliver the last audio twice.
  const stopInFlightRef = useRef<Promise<void> | null>(null);
  /** Set on unmount; a start that resumes after its waits must not leave the microphone on. */
  const disposedRef = useRef(false);

  const start = useCallback(async () => {
    // A start during a stop waits for it, so two captures never overlap.
    const stopping = stopInFlightRef.current;
    if (stopping) {
      await stopping.catch(() => undefined);
    }
    if (disposedRef.current) {
      throw new Error("Dictation audio source was closed");
    }
    const engine = getOrCreateEngine();
    await engine.initialize();
    if (disposedRef.current) {
      throw new Error("Dictation audio source was closed");
    }
    await engine.startCapture();
    if (disposedRef.current) {
      // Closed while capture was starting (for example during the permission prompt).
      await engine.stopCapture().catch(() => undefined);
      throw new Error("Dictation audio source was closed");
    }
  }, [getOrCreateEngine]);

  const stop = useCallback((): Promise<void> => {
    if (stopInFlightRef.current) {
      return stopInFlightRef.current;
    }
    const run = (async () => {
      await engineRef.current?.stopCapture();
      setVolume(0);
    })().finally(() => {
      if (stopInFlightRef.current === run) {
        stopInFlightRef.current = null;
      }
    });
    stopInFlightRef.current = run;
    return run;
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const engine = engineRef.current;
      engineRef.current = null;
      void engine?.destroy().catch(() => undefined);
    };
  }, []);

  return {
    start,
    stop,
    volume,
    isPaused,
  };
}
