// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import {
  useSharedInstallationSignIn,
  useInstallationConnectOnce,
  useClaudeSignInUpgradeAvailable,
  useProviderLogin,
} from "./use-provider-login";
const owner = vi.hoisted(() => ({ status: "locked" }));
const queries = vi.hoisted(() => [] as { enabled?: boolean; queryKey: unknown[] }[]);
vi.mock("@/execution-installation/owner-access", () => ({ useOwnerAccess: () => owner }));
vi.mock("@/execution-installation/policy", () => ({
  findInstallationEnvironment: (_installation: unknown, serverId: string) =>
    serverId === "host" ? { serverId } : null,
  readExecutionInstallation: () => ({
    installationId: "installation",
    environments: [{ kind: "host", serverId: "host" }],
  }),
}));
vi.mock("@/data/query", () => ({
  useFetchQuery: (options: { enabled?: boolean; queryKey: unknown[] }) => {
    queries.push(options);
    return { data: undefined, isError: false, refetch: vi.fn() };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
  useMutation: () => ({ isPending: false }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({}),
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("./use-provider-usage", () => ({ useForceProviderUsageRefresh: () => vi.fn() }));
vi.mock("./claude-setup-login", () => ({
  claudeFullSignInAvailable: vi.fn(),
  claudeSetupRequest: vi.fn(),
  claudeUpgradeAvailable: vi.fn(),
  claudeUpgradeRequest: vi.fn(),
}));
vi.mock("./codex-installation-login", () => ({
  codexInstallationRequest: vi.fn(),
  codexInstallationSignInAvailable: vi.fn(),
}));
afterEach(() => {
  cleanup();
  queries.length = 0;
});
it.each(["checking", "locked"])("disables every installation sign-in query while %s", (status) => {
  owner.status = status;
  renderHook(() => {
    useSharedInstallationSignIn("host", "codex");
    useInstallationConnectOnce(true);
    useClaudeSignInUpgradeAvailable("host", "claude-account-one");
    return useProviderLogin("host", "claude-account-one", "claude");
  });
  expect(queries.length).toBeGreaterThan(5);
  expect(queries.every((query) => query.enabled === false)).toBe(true);
});
it("starts availability and login reads after unlock", () => {
  owner.status = "unlocked";
  renderHook(() => {
    useInstallationConnectOnce(true);
    return useProviderLogin("host", "claude-account-one", "claude");
  });
  expect(queries.filter((query) => query.enabled)).toHaveLength(4);
});

it("keeps unrelated host sign-in available while installation controls are locked", () => {
  owner.status = "locked";
  const hook = renderHook(() => useProviderLogin("other-host", "claude-account-one", "claude"));
  expect(hook.result.current.connected).toBe(true);
  expect(queries.filter((query) => query.enabled)).toHaveLength(1);
});
