import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { dashboardHistoryKey, fetchAuthorizedDashboardHistory } from "./cache";

test("keeps history on transport failure and replaces it on a correlated permission denial", async () => {
  const client = new QueryClient();
  const queryKey = [...dashboardHistoryKey("host"), 0, 1];
  const samples = [{ at: "2026-11-25T12:00:00.000Z", values: { projects: 1 }, unavailable: [] }];
  const history = { access: "granted", samples };
  client.setQueryData(queryKey, history);
  const fetchWithError = (error: Error) =>
    client.fetchQuery({
      queryKey,
      queryFn: () =>
        fetchAuthorizedDashboardHistory(async () => {
          throw error;
        }),
    });
  try {
    await expect(fetchWithError(new Error("Transport disconnected"))).rejects.toThrow();
    expect(client.getQueryData(queryKey)).toEqual(history);
    await fetchWithError(Object.assign(new Error("Denied"), { code: "access_denied" }));
    expect(client.getQueryData(queryKey)).toEqual({ access: "denied" });
  } finally {
    client.clear();
  }
});
