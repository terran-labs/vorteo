import type { PreviewVersion } from "@getpaseo/protocol/previews";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import {
  describePreview,
  previewBadge,
  type PreviewBadge,
  type PreviewBadgeKey,
  type PreviewDescription,
} from "@/preview-status/describe";
import { previewRequestInFlight } from "@/preview-status/use-preview-description";
import { useWorkspaceScriptActions } from "@/screens/workspace/scripts/use-workspace-script-actions";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { matchLivePreview } from "./model";

type WorkspaceScript = WorkspaceDescriptor["scripts"][number];

/** A live link's managed preview on this host, with what the owner reads about it. */
export interface LivePreview {
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  script: WorkspaceScript;
  description: PreviewDescription;
  badge: PreviewBadge | null;
}

const EMPTY_WORKSPACES = new Map<string, WorkspaceDescriptor>();

/**
 * The managed preview behind a url tile, matched only by exact origin across this host's
 * workspaces, or null: for other kinds, an older daemon, no match, or an origin claimed twice.
 * It uses the same rules and strings as the scripts menu.
 */
export function useLivePreview(serverId: string, version: PreviewVersion): LivePreview | null {
  const { t, i18n } = useTranslation();
  const supported = useSessionStore((state) => {
    const features = state.sessions[serverId]?.serverInfo?.features;
    return features?.previewStatus === true && features?.previewRestart === true;
  });
  const workspaces = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces ?? EMPTY_WORKSPACES,
  );
  const liveUrl = version.kind === "url" ? version.liveUrl : null;
  const match = useMemo(() => {
    if (!supported || !liveUrl) return null;
    const all = Array.from(workspaces.values(), (workspace) => ({
      workspaceId: workspace.id,
      scripts: workspace.scripts,
    }));
    const found = matchLivePreview(liveUrl, all);
    if (!found) return null;
    return { ...found, scripts: workspaces.get(found.workspaceId)?.scripts ?? [] };
  }, [liveUrl, supported, workspaces]);
  if (!match?.script.preview) return null;
  const { preview, lifecycle } = match.script;
  const description = describePreview(preview, new Date(), i18n.language, t, lifecycle);
  // A state this app does not know shows nothing, as in the scripts menu.
  if (!description) return null;
  return { ...match, description, badge: previewBadge(preview, lifecycle) };
}

const BADGE_VARIANTS: Record<PreviewBadgeKey, StatusBadgeVariant> = {
  starting: "muted",
  stopping: "muted",
  notResponding: "warning",
  stopped: "muted",
  unavailable: "muted",
  needsRepair: "warning",
  didntStart: "error",
  didntStop: "error",
  linkWithdrawn: "warning",
  unconfirmed: "warning",
  lastKnown: "muted",
};

/** A one-word state over the tile's thumbnail; screen readers hear the whole sentence. */
export function LivePreviewBadge({ live }: { live: LivePreview }) {
  const { t } = useTranslation();
  const { badge } = live;
  if (!badge) return null;
  return (
    <View
      style={styles.badge}
      accessible
      accessibilityLabel={live.description.line}
      testID="preview-live-badge"
    >
      <StatusBadge
        label={t(`previewStatus.badge.${badge.key}`)}
        variant={BADGE_VARIANTS[badge.key]}
        size="xs"
      />
    </View>
  );
}

/** The opened tile's full sentence and its one action, through the scripts menu's actions. */
export function LivePreviewStatus({ serverId, live }: { serverId: string; live: LivePreview }) {
  const { t } = useTranslation();
  const actions = useWorkspaceScriptActions({
    serverId,
    workspaceId: live.workspaceId,
    scripts: live.scripts,
  });
  const { action, line } = live.description;
  const name = live.script.scriptName;
  // As in the scripts menu: wait while a request for this preview is sent or still with the
  // broker, since a second press would only be refused as busy.
  const busy =
    actions.isStopPendingFor(name) ||
    actions.isPreviewPendingFor(name) ||
    previewRequestInFlight(live.script.preview);
  const button = (() => {
    switch (action) {
      case "start":
        return { label: t("previewStatus.actions.start"), run: () => actions.start(name) };
      case "retry":
        // A start or restart outcome: a stop's outcome says "stop". A running preview restarts.
        return {
          label: t("previewStatus.actions.retry"),
          run: () =>
            live.script.lifecycle === "running" ? actions.restart(name) : actions.start(name),
        };
      case "restart":
        return { label: t("previewStatus.actions.restart"), run: () => actions.restart(name) };
      case "stop":
        return { label: t("previewStatus.actions.stop"), run: () => actions.stop(name) };
      default:
        return null;
    }
  })();
  return (
    <View style={styles.status} testID="preview-live-status">
      {/* The app's own sentences always show whole; broker messages are short plain text. */}
      <Text style={styles.line}>{line}</Text>
      {button ? (
        <Button
          variant="outline"
          size="md"
          style={styles.target}
          disabled={busy}
          onPress={button.run}
          testID="preview-live-action"
        >
          {button.label}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: { position: "absolute", left: theme.spacing[1], top: theme.spacing[1] },
  status: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  line: {
    flexShrink: 1,
    flexBasis: 240,
    flexGrow: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  target: { minHeight: 44 },
}));
