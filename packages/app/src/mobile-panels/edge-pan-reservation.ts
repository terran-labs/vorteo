import { useCallback, useRef } from "react";
import type { View } from "react-native";
/** Native gesture arbitration does not involve browser scrolling. */
export function useEdgePanReservation(
  _side: "left" | "right",
  _canStart: () => boolean,
  _identity: () => string | null,
) {
  const ref = useRef<View | null>(null);
  const reset = useCallback(() => {}, []);
  return { ref, reset };
}
