import { createContext, useContext } from "react";
import { useInstallationOwnerAccess } from "./panel";

export interface OwnerAccess {
  status: "none" | "checking" | "locked" | "unlocked";
  busy: boolean;
  error: string | null;
  passwordFile?: string | null;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
}

/** A hook source keeps subscription ownership with the installation panel. */
export type OwnerAccessSource = () => OwnerAccess;
export const OwnerAccessSourceContext = createContext<OwnerAccessSource>(
  useInstallationOwnerAccess,
);

export function useOwnerAccess(): OwnerAccess {
  const useSource = useContext(OwnerAccessSourceContext);
  return useSource();
}
