import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScrollView } from "@/components/ui/scroll-view";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import { FactoryRoleChips, type FactoryChip } from "@/components/sidebar/factory-card-roles";
import { FactoryNeedsYou, FactoryRunners } from "@/components/sidebar/factory-card-runners";
import { LeanConfigEditor } from "./lean-config-editor";
import {
  DEMO_PROVIDER_ENTRIES,
  createDemoLeanInvoke,
  demoLeanStatus,
  demoWireView,
  type DemoState,
} from "./lean-demo";
import { mapLeanView } from "./lean-factory-source";
import { LeanFactoryOverview } from "./lean-overview";
import { leanNeedsYou, leanRunnerIssues, leanRunnerRows, leanTiles } from "./lean-model";

const DEMO_STATES: { value: DemoState; label: string }[] = [
  { value: "ready", label: "Ready" },
  { value: "not-ready", label: "Not ready" },
  { value: "new-project", label: "New project" },
];
const DEMO_PROJECT = "mira";
const noop = () => undefined;

/** A role workspace as the sidebar lists it; it exists only on this page. */
function demoWorkspace(
  serverId: string,
  id: string,
  name: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"],
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${serverId}:${id}`,
    serverId,
    workspaceId: id,
    projectViewKey: "demo",
    projectName: "Mira",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name,
    statusBucket,
    statusEnteredAt: null,
    workspaceDirectory: "/demo/mira",
    workspaceDirectoryLabel: "mira",
    title: name,
    currentBranch: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  } as SidebarWorkspaceEntry;
}

function demoTiles(serverId: string, state: DemoState): FactoryChip[] {
  const chip = (key: string, label: string, entry: SidebarWorkspaceEntry): FactoryChip => ({
    key,
    label,
    entry,
    status: undefined,
    isRole: true,
  });
  const mechanic = chip(
    "factory-mechanic",
    "Mechanic",
    demoWorkspace(serverId, "wks-mechanic", "Mira :: Mechanic", "done"),
  );
  // A new lean project has no Lead record yet; its tile stays, with nothing to open.
  if (state === "new-project") return leanTiles([mechanic]);
  const lead = chip(
    "factory-intake",
    "Foreman",
    demoWorkspace(serverId, "wks-lead", "Mira :: Lead", "running"),
  );
  return leanTiles([lead, mechanic]);
}

/**
 * Development only: the lean sidebar block, overview and settings editor on demo data, so they
 * can be reviewed before any daemon serves lean mode. Reached at /lean-factory-demo. Nothing
 * here reads credentials or talks to a daemon.
 */
export function LeanFactoryDemoScreen() {
  const [demoState, setDemoState] = useState<DemoState>("ready");
  // Each state reads through its own cache keys, like a different daemon.
  const serverId = `lean-demo-${demoState}`;
  const invoke = useMemo(() => createDemoLeanInvoke(demoState), [demoState]);
  const state = useMemo(
    () =>
      ({
        roles: [{ role: "factory-intake", title: "Mira :: Lead", agentId: "agent-lead" }],
      }) as unknown as ProjectFactoryState,
    [],
  );
  const sidebar = useMemo(() => {
    const status = demoLeanStatus();
    const view = mapLeanView(demoWireView(demoState) as never);
    return {
      tiles: demoTiles(serverId, demoState),
      needsYou: leanNeedsYou(status, view),
      runners: leanRunnerIssues(leanRunnerRows(status, view), status),
    };
  }, [demoState, serverId]);
  return (
    <ScrollView contentContainerStyle={styles.page} testID="lean-factory-demo">
      <SegmentedControl
        options={DEMO_STATES}
        value={demoState}
        onValueChange={setDemoState}
        accessibilityLabel="Demo state"
      />
      <Text style={styles.heading}>Sidebar</Text>
      <View style={styles.sidebar}>
        <FactoryRoleChips
          chips={sidebar.tiles}
          level={1}
          activeWorkspaceSelection={null}
          selectionEnabled={false}
          canPinWorkspace={false}
          onToggleWorkspacePin={noop as never}
        />
        <FactoryNeedsYou items={sidebar.needsYou} level={1} onPress={null} />
        <FactoryRunners
          groupKey="lean-demo-runners"
          serverId={serverId}
          runners={sidebar.runners}
          level={1}
        />
      </View>
      <Text style={styles.heading}>Overview</Text>
      <LeanFactoryOverview
        key={`overview-${serverId}`}
        serverId={serverId}
        projectId={DEMO_PROJECT}
        state={state}
        invoke={invoke}
        active
      />
      <Text style={styles.heading}>Settings</Text>
      <LeanConfigEditor
        key={`settings-${serverId}`}
        serverId={serverId}
        projectId={DEMO_PROJECT}
        invoke={invoke}
        active
        providerEntries={DEMO_PROVIDER_ENTRIES}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
    minHeight: "100%",
  },
  heading: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "600" },
  sidebar: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[2],
    maxWidth: 360,
  },
}));
