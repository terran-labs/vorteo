import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import type { GuideStorage } from "./model";

const recordSchema = z.object({
  disposition: z.enum(["skipped", "completed", "paused"]),
  step: z.enum(["appearance", "providers", "projects", "orchestration", "phone"]).optional(),
  updatedAt: z.string(),
});

// Keep upstream's client-wide key intact. Installation identity is public metadata,
// and this record contains neither account credentials nor readiness assertions.
export function guideStorageKey(installationId: string): string {
  return `@vorteo:setup:v1:${encodeURIComponent(installationId)}`;
}

export const guideStorage: GuideStorage = {
  read: (installationId) =>
    readValidatedJson(AsyncStorage, guideStorageKey(installationId), recordSchema),
  write: (installationId, record) =>
    AsyncStorage.setItem(guideStorageKey(installationId), JSON.stringify(record)),
};
