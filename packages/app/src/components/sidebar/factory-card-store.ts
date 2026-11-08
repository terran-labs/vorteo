import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import AsyncStorage from "@/storage/app-storage";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const FactoryCardPersistedStateSchema = z.strictObject({
  collapsed: z.array(z.string()),
  pinned: z.array(z.string()),
});

interface FactoryCardState {
  /** Cards folded to their one-row summary on this device. */
  collapsed: string[];
  /** Cards shown under the root Pinned section instead of in their project, in pin order. */
  pinned: string[];
  toggleCollapsed: (key: string) => void;
  togglePinned: (key: string) => void;
}

function toggle(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key];
}

/** Device-local Factory card preferences. Nothing here reaches the daemon. */
export const useFactoryCardStore = create<FactoryCardState>()(
  persist(
    (set) => ({
      collapsed: [],
      pinned: [],
      toggleCollapsed: (key) => set((state) => ({ collapsed: toggle(state.collapsed, key) })),
      togglePinned: (key) => set((state) => ({ pinned: toggle(state.pinned, key) })),
    }),
    {
      name: "sidebar-factory-cards",
      storage: createValidatedPersistStorage(AsyncStorage, FactoryCardPersistedStateSchema),
      partialize: (state) => ({ collapsed: state.collapsed, pinned: state.pinned }),
      version: 1,
    },
  ),
);
