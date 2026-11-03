import { UPSTREAM_SETUP_ENABLED } from "./index";
import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getOnboardingModel } from "./internal/onboarding-instance";
import { useSetupHostServerId } from "./internal/use-setup-host";

/** Reopens setup on its first step. Null when there is no host to set up. */
export function useOpenOnboarding(): (() => void) | null {
  const serverId = useSetupHostServerId();
  const isCompact = useIsCompactFormFactor();
  const open = useCallback(() => {
    if (!UPSTREAM_SETUP_ENABLED || !serverId) return;
    getOnboardingModel().reopen(serverId, { includePhoneStep: !isCompact });
  }, [isCompact, serverId]);
  return UPSTREAM_SETUP_ENABLED && serverId ? open : null;
}
