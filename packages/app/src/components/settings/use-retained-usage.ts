import { useRef } from "react";
import type { ProviderUsage } from "@/provider-usage/types";

/** Keep the last windows across reconnects, without reserving an empty inner scroller. */
export function useRetainedUsage(latest: ProviderUsage | undefined) {
  const previous = useRef(latest);
  if (latest) previous.current = latest;
  return latest ?? previous.current;
}
