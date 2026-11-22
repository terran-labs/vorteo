import { useCallback, useEffect, useRef } from "react";
import { Buffer } from "buffer";
import { useState } from "react";

import { createAudioEngine } from "@/audio";

import type {
  DictationAudioSource,
  DictationAudioSourceConfig,
} from "./use-dictation-audio-source.types";

/**
 * Microphone stops in flight across every audio source instance. A composer remounted for
 * another thread gets a new source while the old one may still be stopping; its start waits for
 * all of them, so two captures never overlap and the old capture's last audio lands first.
 */
const microphoneStopsInFlight = new Set<Promise<void>>();

function trackMicrophoneStop(stop: Promise<void>): void {
  microphoneStopsInFlight.add(stop);
  void stop.finally(() => {
    microphoneStopsInFlight.delete(stop);
  });
}

/**
 * Longest a start waits for other stops. A stop that never settles (an AudioContext close or a
 * MediaRecorder stop event that hangs on some iOS builds) must not block every later start.
 */
export const MICROPHONE_STOP_WAIT_MS = 5_000;

async function waitForMicrophoneStops(): Promise<void> {
  if (microphoneStopsInFlight.size === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), MICROPHONE_STOP_WAIT_MS);
  });
  const settled = (async () => {
    while (microphoneStopsInFlight.size > 0) {
      await Promise.all([...microphoneStopsInFlight].map((stop) => stop.catch(() => undefined)));
    }
    return "settled" as const;
  })();
  const outcome = await Promise.race([settled, timedOut]);
  if (timer) {
    clearTimeout(timer);
  }
  if (outcome === "timed-out") {
    console.warn(
      "[DictationAudio] A previous microphone stop did not finish; starting anyway",
      microphoneStopsInFlight.size,
    );
  }
}

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
    await waitForMicrophoneStops();
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
    trackMicrophoneStop(run);
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
