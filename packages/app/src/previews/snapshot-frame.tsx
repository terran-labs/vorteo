import type { PreviewKind } from "@getpaseo/protocol/previews";

/** Native platforms have no iframe; the zoom view shows the thumbnail and an open button. */
export const SNAPSHOT_FRAME_AVAILABLE = false;

export function SnapshotFrame(_props: {
  src: string;
  kind: PreviewKind;
  title: string;
  testID?: string;
}) {
  return null;
}
