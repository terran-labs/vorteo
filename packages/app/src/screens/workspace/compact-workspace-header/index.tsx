import { useMemo, type ReactNode } from "react";
import { CompactHeader } from "@/components/headers/compact-header";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

interface CompactWorkspaceHeaderProps {
  serverId: string;
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  /** Tab switcher and workspace menu. */
  children: ReactNode;
}

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  children,
  serverId,
}: CompactWorkspaceHeaderProps) {
  const projectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        serverId={serverId}
      />
    ),
    [subtitle, isSubtitleDistinct, serverId],
  );

  return (
    <CompactHeader
      navigation="menu"
      title={title}
      titleTestID="workspace-header-title"
      subtitle={projectRow}
      loading={isLoading}
      actions={children}
    />
  );
}
