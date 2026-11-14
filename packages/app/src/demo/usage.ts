import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { demoProviderConnections } from "./installation";

type ProviderUsageListPayload = Extract<
  SessionOutboundMessage,
  { type: "provider.usage.list.response" }
>["payload"];

const HOUR_MS = 60 * 60 * 1000;

/**
 * Sample quota readings for the sidebar's Quotas card and the provider settings. Provider IDs
 * match the connected accounts in `installation.ts`. Every account is fictional: no
 * credentials, identities or provider requests stand behind these numbers. Times are relative
 * to the request so the readings never look stale.
 */
export function demoProviderUsage(requestId: string, now = Date.now()): ProviderUsageListPayload {
  const at = (hours: number) => new Date(now + hours * HOUR_MS).toISOString();
  const fetchedAt = at(0);
  const account = (
    providerId: string,
    displayName: string,
    planLabel: string | null,
    windows: ProviderUsageListPayload["providers"][number]["windows"],
  ) => ({
    providerId,
    displayName,
    status: "available" as "available" | "error" | "unavailable",
    planLabel,
    sourceLabel: "Simulated demo data",
    fetchedAt,
    windows,
    reserveWindowIds: windows.map((window) => window.id),
    error: null,
  });
  // Research and Archive follow their simulated sign-in: an expired account offers Reconnect,
  // a signed-out one Connect, and either reads quota once signed in from the demo dialog.
  const signInReadings = () =>
    demoProviderConnections()
      .filter((connection) =>
        ["claude-account-research", "claude-account-archive"].includes(connection.providerId),
      )
      .map((connection) => {
        const name = `${connection.label} (sample)`;
        if (connection.state === "connected")
          return account(connection.providerId, name, "Sample Pro plan", [
            fiveHour(5, 5),
            weekly(10, 150),
          ]);
        if (connection.state === "expired")
          return Object.assign(account(connection.providerId, name, "Sample Pro plan", []), {
            status: "error" as const,
            error: "Sign in again to read usage.",
            authRecovery: { instructions: "Sign in again to keep this account working." },
          });
        return Object.assign(account(connection.providerId, name, null, []), {
          status: "unavailable" as const,
          credentialsMissing: true,
        });
      });
  const fiveHour = (usedPct: number, resetsInHours: number) => ({
    id: "five_hour",
    label: "5-hour window",
    shortLabel: "5h",
    summary: true,
    usedPct,
    remainingPct: 100 - usedPct,
    resetsAt: at(resetsInHours),
  });
  const weekly = (usedPct: number, resetsInHours: number) => ({
    id: "weekly",
    label: "Weekly",
    shortLabel: "wk",
    usedPct,
    remainingPct: 100 - usedPct,
    resetsAt: at(resetsInHours),
  });
  return {
    requestId,
    fetchedAt,
    providers: [
      account("claude-account-work", "Claude · Work (sample)", "Sample Max plan", [
        fiveHour(70, 2),
        weekly(45, 80),
      ]),
      account("claude-account-personal", "Claude · Personal (sample)", "Sample Pro plan", [
        fiveHour(20, 4),
        weekly(30, 120),
      ]),
      account("codex-account-team", "Codex · Team (sample)", "Sample Team plan", [
        fiveHour(35, 3),
        { ...weekly(90, 30), summary: true, tone: "warning" as const },
      ]),
      ...signInReadings(),
    ],
    // The demo's one running worker uses the work account.
    workerActivity: { checkedAt: fetchedAt, runningByProvider: { "claude-account-work": 1 } },
  };
}
