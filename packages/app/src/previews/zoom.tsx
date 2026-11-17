import type { PreviewAnnotation, PreviewVersion } from "@getpaseo/protocol/previews";
import { Columns2, ExternalLink, Maximize2, Trash2 } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useReportActionError } from "@/hooks/use-action-error";
import { formatTimeAgo } from "@/utils/time";
import { canFullscreen, enterFullscreen } from "./fullscreen";
import { annotationLocation, snapshotUrl, type PreviewLineage } from "./model";
import { ApprovedMark, kindLabel, PreviewThumb, StarRating } from "./parts";
import { SNAPSHOT_FRAME_AVAILABLE, SnapshotFrame } from "./snapshot-frame";
import type { PreviewsActions } from "./use-previews";

/** One artifact, large, with its versions, comments and the owner's controls. */
export function PreviewZoom({
  lineage,
  httpBase,
  actions,
  onClose,
}: {
  lineage: PreviewLineage;
  httpBase: string | null;
  actions: PreviewsActions;
  onClose: () => void;
}) {
  const compact = useIsCompactFormFactor();
  const reportError = useReportActionError();
  const [selectedId, setSelectedId] = useState(lineage.newest.id);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const stageRef = useRef<View>(null);

  // Removed versions fall back to the newest one that is left.
  const selected = lineage.versions.find((v) => v.id === selectedId) ?? lineage.newest;
  const compare = comparing
    ? lineage.versions.find((v) => v.id === compareId && v.id !== selected.id)
    : undefined;
  const others = useMemo(
    () => lineage.versions.filter((v) => v.id !== selected.id),
    [lineage.versions, selected.id],
  );
  const fullscreenSupported = SNAPSHOT_FRAME_AVAILABLE && canFullscreen();
  const goFullscreen = useCallback(() => {
    if (!fullscreenSupported) {
      setExpanded((value) => !value);
      return;
    }
    enterFullscreen(stageRef.current).catch(reportError);
  }, [fullscreenSupported, reportError]);
  const toggleCompare = useCallback(() => {
    setComparing((value) => !value);
    setCompareId((current) => current ?? others[0]?.id ?? null);
  }, [others]);
  const openInBrowser = useCallback(() => actions.openInBrowser(selected), [actions, selected]);

  const header = useMemo(
    () => ({
      title: selected.title,
      subtitle: `Version ${selected.number} · ${kindLabel(selected.kind)}`,
    }),
    [selected.kind, selected.number, selected.title],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      desktopMaxWidth={expanded ? 100_000 : 1100}
      desktopHeight={expanded ? "100%" : "90%"}
      testID="preview-zoom"
    >
      <View style={styles.body}>
        <View
          ref={stageRef}
          style={[styles.stageRow, compact && styles.stageColumn, expanded && styles.stageExpanded]}
        >
          <PreviewStage version={selected} httpBase={httpBase} />
          {compare ? <PreviewStage version={compare} httpBase={httpBase} /> : null}
        </View>

        <View style={styles.row}>
          <Button
            variant="outline"
            size="md"
            style={styles.target}
            leftIcon={Maximize2}
            onPress={goFullscreen}
            testID="preview-fullscreen"
          >
            {fullscreenLabel(fullscreenSupported, expanded)}
          </Button>
          <Button
            variant="outline"
            size="md"
            style={styles.target}
            leftIcon={ExternalLink}
            disabled={!actions.canAct || !httpBase}
            onPress={openInBrowser}
            accessibilityHint="Opens the review page in your browser, where you can comment"
            testID="preview-open-browser"
          >
            Open in browser
          </Button>
          {others.length > 0 ? (
            <Button
              variant={comparing ? "secondary" : "outline"}
              size="md"
              style={styles.target}
              leftIcon={Columns2}
              onPress={toggleCompare}
              aria-pressed={comparing}
              testID="preview-compare"
            >
              {comparing ? "Stop comparing" : "Compare"}
            </Button>
          ) : null}
        </View>

        {comparing && others.length > 0 ? (
          <CompareChoices others={others} compareId={compare?.id} onChoose={setCompareId} />
        ) : null}

        <OwnerControls key={selected.id} version={selected} actions={actions} />

        <Text style={styles.sectionTitle}>Versions</Text>
        <View>
          {lineage.versions.map((version) => (
            <VersionRow
              key={version.id}
              version={version}
              selected={version.id === selected.id}
              onSelect={setSelectedId}
            />
          ))}
        </View>

        <Text style={styles.sectionTitle}>
          {selected.annotations.length > 0
            ? `Comments on version ${selected.number}`
            : "No comments on this version yet. Open it in your browser to add some."}
        </Text>
        {selected.annotations.map((annotation) => (
          <AnnotationRow key={annotation.id} annotation={annotation} />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

function fullscreenLabel(supported: boolean, expanded: boolean): string {
  if (supported) return "Full screen";
  return expanded ? "Shrink" : "Expand";
}

function CompareChoices({
  others,
  compareId,
  onChoose,
}: {
  others: PreviewVersion[];
  compareId: string | undefined;
  onChoose: (id: string) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.meta}>Compare with</Text>
      {others.map((other) => (
        <CompareChoice
          key={other.id}
          version={other}
          chosen={other.id === compareId}
          onChoose={onChoose}
        />
      ))}
    </View>
  );
}

function CompareChoice({
  version,
  chosen,
  onChoose,
}: {
  version: PreviewVersion;
  chosen: boolean;
  onChoose: (id: string) => void;
}) {
  const choose = useCallback(() => onChoose(version.id), [onChoose, version.id]);
  const accessibilityState = useMemo(() => ({ selected: chosen }), [chosen]);
  return (
    <Button
      variant={chosen ? "secondary" : "ghost"}
      size="md"
      style={styles.target}
      onPress={choose}
      accessibilityState={accessibilityState}
    >
      {`v${version.number}`}
    </Button>
  );
}

/** Rating, approval and removal for the selected version. Keyed by version, so a pending
 * removal confirmation never carries over to another version. */
function OwnerControls({
  version,
  actions,
}: {
  version: PreviewVersion;
  actions: PreviewsActions;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const disabled = !actions.canAct || actions.pending;
  const { act } = actions;
  const rate = useCallback(
    (rating: number | null) => act({ kind: "rate", versionId: version.id, rating }),
    [act, version.id],
  );
  const toggleApproved = useCallback(
    () => act({ kind: "approve", versionId: version.id, approved: !version.approved }),
    [act, version.approved, version.id],
  );
  const askRemove = useCallback(() => setConfirmingRemove(true), []);
  const cancelRemove = useCallback(() => setConfirmingRemove(false), []);
  const remove = useCallback(() => {
    setConfirmingRemove(false);
    act({ kind: "remove", versionId: version.id });
  }, [act, version.id]);
  return (
    <View style={styles.row}>
      <StarRating rating={version.rating} disabled={!actions.canAct} onRate={rate} />
      <Button
        variant={version.approved ? "secondary" : "outline"}
        size="md"
        style={styles.target}
        disabled={disabled}
        onPress={toggleApproved}
        aria-pressed={version.approved}
        testID="preview-approve"
      >
        {version.approved ? "Approved" : "Approve this version"}
      </Button>
      {confirmingRemove ? (
        <>
          <Button
            variant="destructive"
            size="md"
            style={styles.target}
            disabled={disabled}
            onPress={remove}
            testID="preview-remove-confirm"
          >
            {`Remove version ${version.number}`}
          </Button>
          <Button variant="ghost" size="md" style={styles.target} onPress={cancelRemove}>
            Cancel
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="md"
          style={styles.target}
          leftIcon={Trash2}
          disabled={disabled}
          onPress={askRemove}
          testID="preview-remove"
        >
          Remove
        </Button>
      )}
    </View>
  );
}

function PreviewStage({ version, httpBase }: { version: PreviewVersion; httpBase: string | null }) {
  if (version.kind !== "url" && SNAPSHOT_FRAME_AVAILABLE && httpBase) {
    return (
      <View style={styles.stage}>
        <SnapshotFrame
          src={snapshotUrl(httpBase, version.id, true)}
          kind={version.kind}
          title={`${version.title}, version ${version.number}`}
          testID={`preview-frame-${version.id}`}
        />
      </View>
    );
  }
  return (
    <View style={[styles.stage, styles.stageFallback]}>
      <PreviewThumb version={version} httpBase={httpBase} />
      <Text style={styles.meta}>
        {version.kind === "url"
          ? "This is a live page, not a frozen copy. Open it in your browser to see it."
          : `Version ${version.number}. Open it in your browser to see the full page.`}
      </Text>
    </View>
  );
}

function VersionRow({
  version,
  selected,
  onSelect,
}: {
  version: PreviewVersion;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const select = useCallback(() => onSelect(version.id), [onSelect, version.id]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      onPress={select}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={selected ? styles.versionRowSelected : styles.versionRow}
      testID={`preview-version-${version.id}`}
    >
      <View style={styles.versionHeading}>
        <Text style={styles.versionTitle}>{`v${version.number}`}</Text>
        <Text style={styles.meta}>{formatTimeAgo(new Date(version.createdAt))}</Text>
        {version.rating ? <Text style={styles.meta}>{`${version.rating} of 5`}</Text> : null}
        {version.approved ? <ApprovedMark /> : null}
      </View>
      {version.note ? <Text style={styles.note}>{version.note}</Text> : null}
    </PressHighlight>
  );
}

/** Comment text and selection fields come from the previewed page; plain text only. */
function AnnotationRow({ annotation }: { annotation: PreviewAnnotation }) {
  const meta = [
    annotationLocation(annotation),
    annotation.rating ? `${annotation.rating} of 5` : null,
    formatTimeAgo(new Date(annotation.createdAt)),
    annotation.delivery === "queued" ? "Sent to the thread" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={styles.annotation}>
      <Text style={styles.note}>{annotation.comment}</Text>
      <Text style={styles.meta} numberOfLines={1}>
        {meta}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  stageRow: { flexDirection: "row", gap: theme.spacing[2], height: 520 },
  stageColumn: { flexDirection: "column", height: undefined },
  stageExpanded: { height: 800 },
  stage: {
    flex: 1,
    minHeight: 320,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
  stageFallback: { padding: theme.spacing[3], gap: theme.spacing[2], justifyContent: "center" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  target: { minHeight: 44 },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  versionRow: {
    minHeight: 44,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    gap: theme.spacing[1],
    justifyContent: "center",
  },
  // A complete style of its own: combining two styles at module scope would read the
  // stylesheet before the persisted theme loads.
  versionRowSelected: {
    minHeight: 44,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    gap: theme.spacing[1],
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  versionHeading: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  versionTitle: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  note: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  annotation: {
    gap: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
}));
