import { ProjectRailPreview } from "./project-rail-preview";
import { memo, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SidebarInsetContext } from "./sidebar-separator";
import { StyleSheet } from "react-native-unistyles";
import { COMPACT_RAIL_MARGIN } from "@/stores/panel-store/state";
import {
  useSidebarProjectStatusBucket,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

interface CompactProjectRailProps {
  header: ReactNode;
  footer: ReactNode;
  workspaceEntries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projects: SidebarProjectEntry[];
  onSelectProject: (key: string) => void;
  /** After a flyout Focus button focuses its item: expands the sidebar to show it. */
  onFocused: () => void;
}

const ProjectRailItem = memo(function ProjectRailItem({
  project,
  workspaceEntries,
  onSelect,
  onFocused,
}: {
  project: SidebarProjectEntry;
  workspaceEntries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  onSelect: (key: string) => void;
  onFocused: () => void;
}) {
  const bucket = useSidebarProjectStatusBucket({ workspaces: project.workspaces, enabled: true });
  const initials =
    project.projectName
      .trim()
      .split(/\s+/)
      .map((part) => Array.from(part)[0])
      .slice(0, 2)
      .join("")
      .toLocaleUpperCase() || "?";
  return (
    <View style={styles.item}>
      <ProjectRailPreview
        workspaceEntries={workspaceEntries}
        project={project}
        initials={initials}
        onSelect={onSelect}
        onFocused={onFocused}
      />
      {bucket && bucket !== "done" ? (
        <View
          pointerEvents="none"
          style={[styles.dot, initials.length > 1 && styles.dotWide, statusDotStyle(bucket)]}
        />
      ) : null}
    </View>
  );
});

/**
 * A rule across the whole rail, through its margin and the sidebar's inset, like the rules
 * around the full sidebar's list. `hidden` keeps its place so the scroller never shifts.
 */
function RailRule({ hidden = false, testID }: { hidden?: boolean; testID: string }) {
  const inset = useContext(SidebarInsetContext);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.rule,
        hidden && styles.ruleHidden,
        inlineUnistylesStyle({ marginHorizontal: -(inset + COMPACT_RAIL_MARGIN) }),
      ]}
      testID={testID}
    />
  );
}

/** Whether the projects fill the scroller down to the footer, as the full sidebar's list rule. */
function useReachesFooter() {
  const sizes = useRef({ viewport: 0, content: 0 });
  const [reaches, setReaches] = useState(true);
  const update = useCallback(() => {
    const { viewport, content } = sizes.current;
    setReaches(viewport === 0 || content === 0 || content >= viewport - 1);
  }, []);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      sizes.current.viewport = event.nativeEvent.layout.height;
      update();
    },
    [update],
  );
  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      sizes.current.content = height;
      update();
    },
    [update],
  );
  return { reaches, onLayout, onContentSizeChange };
}

export function CompactProjectRail({
  header,
  footer,
  workspaceEntries,
  projects,
  onSelectProject,
  onFocused,
}: CompactProjectRailProps) {
  const reach = useReachesFooter();
  return (
    <View style={styles.rail} testID="compact-project-rail">
      {header}
      <RailRule testID="compact-rail-top-rule" />
      {/* The shared scroller dissolves projects under the rules while more lies past them. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.projects}
        onLayout={reach.onLayout}
        onContentSizeChange={reach.onContentSizeChange}
        showsVerticalScrollIndicator={false}
        testID="compact-rail-scroll"
      >
        {projects.map((project) => (
          <ProjectRailItem
            workspaceEntries={workspaceEntries}
            key={project.viewKey}
            project={project}
            onSelect={onSelectProject}
            onFocused={onFocused}
          />
        ))}
      </ScrollView>
      <RailRule hidden={!reach.reaches} testID="compact-rail-bottom-rule" />
      {footer}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    paddingHorizontal: COMPACT_RAIL_MARGIN,
    paddingBottom: COMPACT_RAIL_MARGIN,
    gap: 2,
  },
  header: { height: 48, justifyContent: "center" },
  scroll: { flex: 1, width: "100%" },
  projects: { alignItems: "center", gap: 2 },
  item: { position: "relative" },
  button: { width: 44, height: 44, paddingHorizontal: 0 },
  label: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.display,
    fontSize: theme.fontSize.base,
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  // Tucked against the initials' top-right rather than the button's corner, so it reads as theirs.
  dot: { position: "absolute", right: 9, top: 11, width: 7, height: 7, borderRadius: 4 },
  // Two initials are wider, so the dot sits a little further out to clear the second letter.
  dotWide: { right: 5 },
  rule: {
    alignSelf: "stretch",
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.divider,
  },
  ruleHidden: { backgroundColor: "transparent" },
  failed: { backgroundColor: theme.colors.statusDotDanger },
  running: { backgroundColor: theme.colors.statusDotRunning },
  attention: { backgroundColor: theme.colors.statusDotWarning },
}));

function statusDotStyle(bucket: string) {
  if (bucket === "failed") return styles.failed;
  if (bucket === "running") return styles.running;
  return styles.attention;
}
