import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import storage from "@/storage/app-storage";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const schema = z.object({ hidden: z.record(z.string(), z.array(z.string())) });
export const useDashboardPreferences = create<z.infer<typeof schema>>()(
  persist(() => ({ hidden: {} }), {
    name: "dashboard-card-preferences",
    storage: createValidatedPersistStorage(storage, schema),
    version: 1,
  }),
);

export function toggleCard(serverId: string, key: string) {
  useDashboardPreferences.setState(({ hidden }) => {
    const current = hidden[serverId] ?? [];
    const next = current.includes(key) ? current.filter((id) => id !== key) : [...current, key];
    return { hidden: { ...hidden, [serverId]: next } };
  });
}
