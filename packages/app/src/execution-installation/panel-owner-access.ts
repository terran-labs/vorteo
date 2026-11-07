import { useCallback, useSyncExternalStore } from "react";
import type { InstallationPanelModel } from "./panel-model";
import type { OwnerAccess } from "./owner-access";

type OwnerPanelState = Pick<
  ReturnType<InstallationPanelModel["getState"]>,
  "initialized" | "unlocked" | "busy" | "error" | "passwordFile"
>;
export interface OwnerPanelSource extends Pick<
  InstallationPanelModel,
  "subscribe" | "setPassword" | "clearPasswordDraft" | "unlock" | "lock"
> {
  getState(): OwnerPanelState;
}
const noSubscription = () => () => {};
const emptyState = () => null;

/** Adapt the panel's single session, including its initialization and expired-session updates. */
export function usePanelOwnerAccess({
  model,
  installationPresent,
}: {
  model: OwnerPanelSource | null;
  installationPresent: boolean;
}): OwnerAccess {
  const state = useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    model?.getState ?? emptyState,
    model?.getState ?? emptyState,
  );
  const unlock = useCallback(
    async (password: string) => {
      if (!model) return;
      model.setPassword(password);
      try {
        await model.unlock();
        const result = model.getState();
        if (!result.unlocked) throw new Error(result.error || "Wrong password");
      } finally {
        // Clear the secret without erasing the error shown by the unlock dialog.
        model.setPassword("");
      }
    },
    [model],
  );
  const lock = useCallback(async () => {
    if (!model) return;
    await model.lock();
    // The panel model records errors rather than rejecting its action promise.
    const result = model.getState();
    if (result.unlocked && result.error) throw new Error(result.error);
  }, [model]);
  let status: OwnerAccess["status"] = installationPresent ? "checking" : "none";
  if (installationPresent && state?.initialized) status = state.unlocked ? "unlocked" : "locked";
  return {
    status,
    busy: state?.busy ?? false,
    error: state?.error ?? null,
    passwordFile: state?.passwordFile,
    unlock,
    lock,
  };
}
