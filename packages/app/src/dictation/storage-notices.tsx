import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { getDeviceDictationRecordingStore } from "./device-recording-store";

/**
 * The one place that tells the owner about dictation storage, so several mounted composers never
 * repeat a notice. The store reports "unavailable" at most once per recording and each eviction
 * once.
 */
export function DictationStorageNotices(): null {
  const { t } = useTranslation();
  const toast = useToast();
  useEffect(
    () =>
      getDeviceDictationRecordingStore().subscribe((event) => {
        if (event.kind === "evicted") {
          toast.error(t("message.dictation.recordingEvicted"));
        } else if (event.kind === "unavailable") {
          toast.error(t("message.dictation.storageUnavailable"));
        }
      }),
    [t, toast],
  );
  return null;
}
