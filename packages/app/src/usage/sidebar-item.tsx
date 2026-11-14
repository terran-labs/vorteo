import { router } from "expo-router";
import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { buildUsageRoute } from "@/utils/host-routes";

/**
 * Opens the Usage screen, over the sidebar on compact layouts. The sidebar's usage meter beside
 * the installation name and the Quota card use it. The old sidebar Usage summary row, its pinned
 * windows and its options popover were removed: nothing rendered them.
 */
export function useOpenUsageScreen(): () => void {
  const isCompact = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  return useCallback(() => {
    if (isCompact) showMobileAgent();
    router.push(buildUsageRoute());
  }, [isCompact, showMobileAgent]);
}
