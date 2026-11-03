import { createContext, useContext } from "react";
import { useInstallationOwnerClient } from "./panel";
import { readExecutionInstallation } from "./policy";

export interface OwnerAccess {
  status: "none" | "checking" | "locked" | "unlocked";
  busy: boolean;
  error: string | null;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
}

/** A hook source keeps subscription ownership with the installation panel. */
export type OwnerAccessSource = () => OwnerAccess;
export const OwnerAccessSourceContext = createContext<OwnerAccessSource>(useImportableOwnerAccess);

async function unavailable(): Promise<void> {
  throw new Error(
    "Owner controls are not connected yet. Use Installation controls in General settings.",
  );
}

// Replace this source with useInstallationOwnerAccess when the held panel exports it.
// The client alone cannot distinguish session restoration from a locked session,
// or expose the model's actions. Never create a second owner session here.
function useImportableOwnerAccess(): OwnerAccess {
  const client = useInstallationOwnerClient();
  let status: OwnerAccess["status"] = "none";
  if (readExecutionInstallation()) status = client ? "unlocked" : "locked";
  return {
    status,
    busy: false,
    error: null,
    unlock: unavailable,
    lock: unavailable,
  };
}

export function useOwnerAccess(): OwnerAccess {
  const useSource = useContext(OwnerAccessSourceContext);
  return useSource();
}
