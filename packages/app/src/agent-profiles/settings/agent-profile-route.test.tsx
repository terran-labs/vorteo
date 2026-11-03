// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { SharedProviderPreferences } from "@getpaseo/protocol/messages";
import type { AgentProfilePageProps } from "./agent-profile-page";
import ProfileRoute from "@/app/settings/profiles/[profileId]";
const mocks = vi.hoisted(() => ({
  profileId: "workflow",
  catalogProvider: "claude",
  props: null as AgentProfilePageProps | null,
  shared: undefined as SharedProviderPreferences | undefined,
  saveWorkflow: vi.fn(),
  saveDefaults: vi.fn(),
  deleteWorkflow: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({
    serverId: "host",
    providerType: mocks.catalogProvider,
    profileId: mocks.profileId,
  }),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/host-route-bootstrap-boundary", () => ({
  HostRouteBootstrapBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./agent-profile-page", () => ({
  AgentProfilePage: (props: AgentProfilePageProps) => {
    mocks.props = props;
    return null;
  },
}));
vi.mock("./preferred-choices-field", () => ({ PreferredChoicesField: () => null }));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [] }),
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: { providers: {} } }),
}));
vi.mock("./use-shared-provider-profiles", () => {
  return {
    sharedProviderGroup: (snapshot: SharedProviderPreferences, providerType: string) =>
      snapshot.providers[providerType],
    useSharedProviderProfiles: () => ({
      ready: true,
      shared: mocks.shared,
      providerType: "claude",
      saveWorkflow: mocks.saveWorkflow,
      saveDefaults: mocks.saveDefaults,
      deleteWorkflow: mocks.deleteWorkflow,
    }),
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.props = null;
  mocks.profileId = "workflow";
  mocks.catalogProvider = "claude";
  mocks.shared = {
    version: 1,
    revision: 7,
    legacyProfiles: {},
    providers: {
      claude: {
        defaults: { model: "default-model" },
        workflows: [{ id: "workflow", name: "Review", provider: "claude" }],
        preferredModels: ["default-model"],
        preferredThinkingOptions: [],
        defaultWorkflowId: "workflow",
      },
    },
  };
});
afterEach(cleanup);
it("edits shared workflows and retains the reviewed revision after polling", async () => {
  const { rerender } = render(<ProfileRoute />);
  expect(mocks.props?.profile).toMatchObject({
    id: "workflow",
    name: "Review",
    model: "default-model",
  });
  const snapshot = mocks.shared;
  mocks.shared = { ...mocks.shared!, revision: 8 };
  rerender(<ProfileRoute />);
  await mocks.props!.onSave({ name: "Changed", provider: "claude" });
  expect(mocks.saveWorkflow).toHaveBeenCalledWith(
    { id: "workflow", name: "Changed", provider: "claude" },
    snapshot,
  );
  await mocks.props!.onDelete!();
  expect(mocks.deleteWorkflow).toHaveBeenCalledWith("workflow", snapshot);
  mocks.props!.onBack();
  expect(mocks.replace).toHaveBeenCalledWith({
    pathname: "/settings/accounts/[providerType]",
    params: { providerType: "claude", serverId: "host" },
  });
});
it("creates shared workflows using a generated id", async () => {
  mocks.profileId = "new";
  render(<ProfileRoute />);
  expect(mocks.props?.mode).toBe("create");
  expect(mocks.props?.profile.id).not.toBe("new");
  expect(mocks.props?.onDelete).toBeUndefined();
  await mocks.props!.onSave({ name: "New", provider: "claude" });
  expect(mocks.saveWorkflow).toHaveBeenCalledWith(
    { id: mocks.props!.profile.id, name: "New", provider: "claude" },
    mocks.shared,
  );
});
it("uses the defaults variant and saves preferred choices in the same revision", async () => {
  mocks.profileId = "defaults";
  render(<ProfileRoute />);
  expect(mocks.props?.sharedScope?.kind).toBe("defaults");
  expect(mocks.props?.onDelete).toBeUndefined();
  await mocks.props!.onSave({ name: "Provider defaults", provider: "claude", model: "new-model" });
  expect(mocks.saveDefaults).toHaveBeenCalledWith(
    { name: "Provider defaults", provider: "claude", model: "new-model" },
    mocks.shared,
    { preferredModels: ["default-model"], preferredThinkingOptions: [] },
  );
  expect(mocks.saveWorkflow).not.toHaveBeenCalled();
});

it("returns to the provider family when the editor uses an account catalog", () => {
  mocks.catalogProvider = "claude-account";
  render(<ProfileRoute />);
  expect(mocks.props!.profile.provider).toBe("claude-account");
  mocks.props!.onBack();
  expect(mocks.replace).toHaveBeenCalledWith({
    pathname: "/settings/accounts/[providerType]",
    params: { providerType: "claude", serverId: "host" },
  });
});
