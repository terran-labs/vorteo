import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/** The three Factory overview designs the owner is comparing. */
export const FACTORY_OVERVIEW_VARIANTS = ["floor", "mission", "ledger"] as const;
export type FactoryOverviewVariant = (typeof FACTORY_OVERVIEW_VARIANTS)[number];

const persistedSchema = z.object({
  variant: z.enum(FACTORY_OVERVIEW_VARIANTS),
  sample: z.boolean(),
});

interface FactoryOverviewStoreState {
  variant: FactoryOverviewVariant;
  /** Show the deterministic sample queue instead of the live one. */
  sample: boolean;
  setVariant: (variant: FactoryOverviewVariant) => void;
  setSample: (sample: boolean) => void;
}

// Remembered per device, like other view preferences.
export const useFactoryOverviewStore = create<FactoryOverviewStoreState>()(
  persist(
    (set) => ({
      variant: "floor",
      sample: false,
      setVariant: (variant) => set({ variant }),
      setSample: (sample) => set({ sample }),
    }),
    {
      name: "factory-overview-view",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, persistedSchema),
      partialize: (state) => ({ variant: state.variant, sample: state.sample }),
    },
  ),
);
