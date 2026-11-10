import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// Unknown fields from older saved design choices are intentionally discarded.
const persistedSchema = z.object({ sample: z.boolean() });
interface FactoryOverviewStoreState {
  sample: boolean;
  setSample: (sample: boolean) => void;
}

// Remembered per device, like other view preferences.
export const useFactoryOverviewStore = create<FactoryOverviewStoreState>()(
  persist(
    (set) => ({
      sample: false,
      setSample: (sample) => set({ sample }),
    }),
    {
      name: "factory-overview-view",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, persistedSchema),
      partialize: (state) => ({
        sample: state.sample,
      }),
    },
  ),
);
