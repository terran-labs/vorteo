import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { readValidatedJson, type ValidatedStorage } from "@/storage/validated-storage";
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

interface GuideStorageBackend extends ValidatedStorage {
  setItem(key: string, value: string): Promise<void>;
}

export function createGuideStorage(backend: GuideStorageBackend): GuideStorage {
  return {
    read: (installationId) =>
      readValidatedJson(backend, guideStorageKey(installationId), recordSchema),
    write: (installationId, record) =>
      backend.setItem(guideStorageKey(installationId), JSON.stringify(record)),
  };
}

export const guideStorage: GuideStorage = createGuideStorage(AsyncStorage);
