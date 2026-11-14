import type { PreviewKind } from "@getpaseo/protocol/previews";

export const SNAPSHOT_FRAME_AVAILABLE = true;

/**
 * Snapshots are agent-authored. `allow-same-origin` is never granted, so the page gets an opaque
 * origin and cannot read this app's storage or the daemon session even when both share a host.
 * Scripts, forms and popups stay on so decks and interactive mockups work.
 *
 * PDF versions are the one exception: browsers refuse to render a PDF inside a sandboxed frame,
 * so they get no `sandbox` attribute. The daemon serves that file as application/pdf with
 * nosniff, so it can only open in the browser's PDF viewer, which never exposes the embedding
 * origin's storage to the file. That holds even where the app and daemon share an origin
 * (container installs serve the interface from the daemon). Every HTML snapshot also carries a
 * `Content-Security-Policy: sandbox` header from the daemon, and keeps this attribute as well.
 */
const SANDBOX = "allow-scripts allow-forms allow-popups";

const frameStyle = {
  flex: 1,
  width: "100%",
  height: "100%",
  minHeight: 0,
  border: "none",
} as const;

export function SnapshotFrame({
  src,
  title,
  kind,
  testID,
}: {
  src: string;
  kind: PreviewKind;
  title: string;
  testID?: string;
}) {
  return (
    <iframe
      data-testid={testID}
      title={title}
      src={src}
      sandbox={kind === "pdf" ? undefined : SANDBOX}
      referrerPolicy="no-referrer"
      style={frameStyle}
    />
  );
}
