// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useLocalSpeechModels } from "./use-local-speech-models";

const host = vi.hoisted(() => ({
  supported: false,
  client: {
    listLocalSpeechModels: vi.fn(async () => []),
    downloadLocalSpeechModel: vi.fn(async () => {}),
    deleteLocalSpeechModel: vi.fn(async () => {}),
  },
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_id: string, feature: string) => feature === "speechSettings" && host.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => host.client,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  host.supported = false;
});

test("a connected daemon without speech settings receives no model requests", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const { result, rerender } = renderHook(() => useLocalSpeechModels("old-host"), { wrapper });
  await act(async () => {
    result.current.refresh();
    await result.current.download("model");
    await result.current.remove("model");
    await cache.invalidateQueries();
  });
  expect(host.client.listLocalSpeechModels).not.toHaveBeenCalled();
  expect(host.client.downloadLocalSpeechModel).not.toHaveBeenCalled();
  expect(host.client.deleteLocalSpeechModel).not.toHaveBeenCalled();
  host.supported = true;
  rerender();
  await waitFor(() => expect(host.client.listLocalSpeechModels).toHaveBeenCalledOnce());
  host.supported = false;
  rerender();
  await act(async () => {
    result.current.refresh();
    await cache.invalidateQueries();
  });
  expect(host.client.listLocalSpeechModels).toHaveBeenCalledOnce();
  cache.clear();
});
