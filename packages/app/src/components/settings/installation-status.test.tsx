vi.mock("@/utils/error-messages", () => ({
  isConnectionError: () => false,
  toErrorMessage: String,
}));
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({
  installation: { environments: [] },
  data: { revision: 1, settings: {}, sources: {} },
  error: null,
  isFetching: false,
  save: vi.fn(),
}));
vi.mock("@/execution-installation/settings", () => ({ useInstallationSettings: () => state }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock("@/hooks/use-action-error", () => ({ useReportActionError: () => vi.fn() }));
vi.mock("react-native", () => ({
  Text: "span",
  View: "div",
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));
vi.mock("@/components/ui/alert", () => ({ Alert: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/settings/headings/settings-section", () => ({ SettingsSection: () => null }));
import {
  InstallationSettingsStatus,
  InstallationSettingsSyncStatus,
} from "@/execution-installation/settings-status";

describe("InstallationSettingsStatus", () => {
  it("keeps loaded children unchanged during a background refetch", () => {
    const render = () =>
      renderToStaticMarkup(
        <InstallationSettingsStatus>
          <div>Settings content</div>
        </InstallationSettingsStatus>,
      );
    const initial = render();
    state.isFetching = true;
    expect(render()).toBe(initial);
    expect(initial).toContain("Settings content");
  });
});

it.each([
  "read_failed",
  "patch_failed",
  "verification_failed",
  "plugin_projection_failed",
  "skill_projection_failed",
])("shows %s without a pending revision", (error) => {
  state.data.sources = { host: { error, pendingRevision: null } };
  const markup = renderToStaticMarkup(<InstallationSettingsSyncStatus />);
  expect(markup).toContain(
    "Some environments haven&#x27;t applied the latest shared settings yet.",
  );
  state.data.sources = {};
});
