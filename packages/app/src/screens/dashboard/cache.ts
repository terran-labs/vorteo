import type { DashboardSample } from "@getpaseo/protocol/messages";

export const dashboardHistoryKey = (serverId: string) => ["dashboard-history", serverId] as const;

function isDashboardAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "access_denied" || error.code === "permission_denied";
}

export async function fetchAuthorizedDashboardHistory(
  request: () => Promise<{ samples: DashboardSample[]; error: string | null }>,
) {
  try {
    const result = await request();
    if (result.error) throw new Error(result.error);
    return { access: "granted" as const, samples: result.samples };
  } catch (error) {
    // A rejected query retains its former data. Replace it on an authoritative denial.
    if (isDashboardAccessDenied(error)) return { access: "denied" as const };
    throw error;
  }
}
