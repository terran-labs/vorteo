/** @vitest-environment jsdom */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceLifecycleIndicators } from "./indicators";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
vi.mock("lucide-react-native", () => ({
  LockKeyhole: () => <span>Lock</span>,
  Factory: () => <span>Factory</span>,
  Repeat2: () => <span>Repeat</span>,
  CirclePause: () => <span>Pause</span>,
}));
vi.mock("./factory-membership", () => ({
  useFactoryMembership: () => ({ role: "factory" }),
  FACTORY_MANAGED_EXPLANATION: "Factory managed",
}));
vi.mock("./system-membership", () => ({
  useSystemManaged: () => false,
  SYSTEM_MANAGED_EXPLANATION: "System managed",
}));
vi.mock("./scheduled", () => ({ useWorkspaceScheduleState: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: () => null,
  TooltipText: () => null,
}));
beforeEach(() => vi.stubGlobal("React", React));
afterEach(cleanup);
const workspace = {
  serverId: "host",
  workspaceId: "role",
  protected: true,
} as SidebarWorkspaceEntry;
it("shows neither a Factory marker nor a lock for protected Factory members", () => {
  const { container } = render(<WorkspaceLifecycleIndicators workspace={workspace} hideFactory />);
  expect(container.querySelector('[data-testid="workspace-factory-role"]')).toBeNull();
  expect(container.querySelector('[data-testid="workspace-shield-role"]')).toBeNull();
});
