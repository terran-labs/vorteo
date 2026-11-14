import type { PreviewGallery } from "@getpaseo/protocol/previews";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { useCardDisclosure } from "@/agent-stream/use-card-disclosure";
import { CountBadge } from "@/components/ui/count-badge";
import { PressHighlight } from "@/components/ui/press-highlight";
import { hoverGroup } from "@/styles/hover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatTimeAgo } from "@/utils/time";
import {
  groupByLineage,
  scopeVersions,
  sortLineages,
  variantGroups,
  type PreviewLineage,
  type PreviewScope,
  type PreviewSort,
} from "./model";
import { ApprovedMark, PreviewThumb } from "./parts";
import { PREVIEW_TILE_HOVER_GROUP, TileRating } from "./tile-rating";
import {
  usePreviewsActions,
  usePreviewsGallery,
  usePreviewsHttpBase,
  usePreviewsSupported,
  type PreviewsActions,
} from "./use-previews";
import { VariantGroupView } from "./variants";
import { PreviewZoom } from "./zoom";

const HEADING_ICON = <TaskCardIcon kind="previews" />;
const SCOPE_OPTIONS = [
  { value: "thread" as const, label: "This thread", testID: "previews-scope-thread" },
  { value: "all" as const, label: "This workspace", testID: "previews-scope-all" },
];
const SORT_OPTIONS = [
  { value: "newest" as const, label: "Newest", testID: "previews-sort-newest" },
  { value: "rating" as const, label: "Rating", testID: "previews-sort-rating" },
];

/** Artifacts agents published for review. Hidden until the daemon advertises Previews. */
export function PreviewsCard({ serverId, agentId }: { serverId: string; agentId: string }) {
  const supported = usePreviewsSupported(serverId);
  const gallery = usePreviewsGallery(serverId, agentId, supported).data;
  if (!supported || !gallery || gallery.versions.length === 0) return null;
  return <PreviewsContent serverId={serverId} agentId={agentId} gallery={gallery} />;
}

function PreviewsContent({
  serverId,
  agentId,
  gallery,
}: {
  serverId: string;
  agentId: string;
  gallery: PreviewGallery;
}) {
  const [expanded, setExpanded] = useCardDisclosure("previews");
  const toggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  // The card opens on this thread's previews; the workspace view is one tap away.
  const [scope, setScope] = useState<PreviewScope>("thread");
  const [sort, setSort] = useState<PreviewSort>("newest");
  const [zoomLineage, setZoomLineage] = useState<string | null>(null);
  const httpBase = usePreviewsHttpBase(serverId);
  const actions = usePreviewsActions(serverId, agentId, httpBase);

  const inScope = useMemo(
    () => scopeVersions(gallery.versions, scope, agentId),
    [agentId, gallery.versions, scope],
  );
  const lineages = useMemo(() => sortLineages(groupByLineage(inScope), sort), [inScope, sort]);
  const variants = useMemo(() => variantGroups(gallery, inScope), [gallery, inScope]);
  // The zoom follows the live gallery, so a removed lineage closes it.
  const zoomed =
    lineages.find((item) => item.lineage === zoomLineage) ??
    groupByLineage(gallery.versions).find((item) => item.lineage === zoomLineage);
  const closeZoom = useCallback(() => setZoomLineage(null), []);

  const badge = useMemo(
    () => (
      <CountBadge
        count={lineages.length}
        label={String(lineages.length)}
        accessibilityLabel={`${lineages.length} previews`}
        testID="previews-count"
      />
    ),
    [lineages.length],
  );

  return (
    <TaskCard flushBody testID="previews-card" bodyVisible={expanded}>
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title="Previews"
          expanded={expanded}
          onPress={toggle}
          count={badge}
          testID="previews-toggle"
        />
      </TaskCardHeader>
      {expanded ? (
        <View style={styles.body}>
          <View style={[styles.controls, taskCardStyles.proseInset]}>
            <SegmentedControl
              options={SCOPE_OPTIONS}
              value={scope}
              onValueChange={setScope}
              testID="previews-scope"
            />
            <SegmentedControl
              options={SORT_OPTIONS}
              value={sort}
              onValueChange={setSort}
              testID="previews-sort"
            />
          </View>
          {variants.map((group) => (
            <VariantGroupView
              key={group.set.id}
              group={group}
              httpBase={httpBase}
              actions={actions}
            />
          ))}
          {lineages.length === 0 ? (
            <Text style={[styles.empty, taskCardStyles.proseInset]}>
              This thread has not published any previews. Switch to All to see the rest.
            </Text>
          ) : (
            <View style={[styles.grid, taskCardStyles.proseInset]}>
              {lineages.map((lineage) => (
                <PreviewTile
                  key={lineage.lineage}
                  lineage={lineage}
                  httpBase={httpBase}
                  showAgent={scope === "all"}
                  actions={actions}
                  onOpen={setZoomLineage}
                />
              ))}
            </View>
          )}
          {httpBase ? null : (
            <Text style={[styles.empty, taskCardStyles.proseInset]}>
              Thumbnails and the preview viewer need a direct connection to this host. This
              connection goes through a relay or a local socket.
            </Text>
          )}
        </View>
      ) : null}
      {zoomed ? (
        <PreviewZoom lineage={zoomed} httpBase={httpBase} actions={actions} onClose={closeZoom} />
      ) : null}
    </TaskCard>
  );
}

function PreviewTile({
  lineage,
  httpBase,
  showAgent,
  actions,
  onOpen,
}: {
  lineage: PreviewLineage;
  httpBase: string | null;
  showAgent: boolean;
  actions: PreviewsActions;
  onOpen: (lineage: string) => void;
}) {
  const version = lineage.newest;
  const open = useCallback(() => onOpen(lineage.lineage), [lineage.lineage, onOpen]);
  const rate = useCallback(
    (rating: number | null) => actions.act({ kind: "rate", versionId: version.id, rating }),
    [actions, version.id],
  );
  const count = lineage.versions.length;
  const meta = [
    `v${version.number}`,
    count > 1 ? `${count} versions` : null,
    formatTimeAgo(new Date(version.createdAt)),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={styles.tile} testID={`preview-tile-${lineage.lineage}`}>
      <View style={styles.thumbArea}>
        <PressHighlight
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`Open ${version.title}`}
          style={styles.thumbButton}
        >
          <PreviewThumb version={version} httpBase={httpBase} />
        </PressHighlight>
        {/* A sibling of the thumbnail button, not a child, so rating never opens the preview. */}
        <TileRating
          rating={version.rating}
          disabled={!actions.canAct}
          onRate={rate}
          testID={`preview-rating-${lineage.lineage}`}
        />
      </View>
      <PressHighlight
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`Open ${version.title}`}
        style={styles.tileButton}
      >
        <Text style={styles.title} numberOfLines={2}>
          {version.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
        {showAgent && version.agentTitle ? (
          <Text style={styles.meta} numberOfLines={1}>
            {version.agentTitle}
          </Text>
        ) : null}
      </PressHighlight>
      {version.approved ? <ApprovedMark /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[2] },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  // Wide enough for five 44px stars over the thumbnail; tiles wrap to one per row on phones.
  tile: {
    flexGrow: 1,
    flexBasis: 228,
    minWidth: 228,
    maxWidth: 320,
    gap: theme.spacing[1],
    ...hoverGroup(PREVIEW_TILE_HOVER_GROUP),
  },
  thumbArea: { position: "relative" },
  thumbButton: { borderRadius: theme.borderRadius.md },
  tileButton: { gap: theme.spacing[1], minHeight: 44, borderRadius: theme.borderRadius.md },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
