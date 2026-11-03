import { Gauge } from "lucide-react-native";
import { useMemo } from "react";
import { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { GlobalCard } from "@/components/sidebar/global-card-shell";
import type { Theme } from "@/styles/theme";
import { useUsageHostId } from "@/usage/hosts";
import { useOpenUsageScreen } from "@/usage/sidebar-item";
import { attentionCount, quotaAccounts } from "./global-quota";
import { QuotaAccountList } from "./quota-account-list";
import { QuotaFooter } from "./quota-footer";
import { useProviderUsage } from "./use-provider-usage";

const QuotaIcon = withUnistyles(Gauge);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const HEADING_ICON = (
  <View style={{ width: 16, alignItems: "center" }}>
    <QuotaIcon size={14} uniProps={iconColor} />
  </View>
);

/**
 * Every account's quotas on the usage host: the account to use next, a week-long runway lane
 * per account, and every window, balance and action when an account is opened.
 */
export function GlobalQuotaCard() {
  const serverId = useUsageHostId();
  const { view } = useProviderUsage(serverId, { pollUsage: true });
  // Readings refresh every minute, so minute-precision countdowns only need the render time.
  const now = useMemo(() => (view.kind === "ready" ? Date.now() : 0), [view]);
  const accounts = useMemo(() => quotaAccounts(view, now), [view, now]);
  const openUsage = useOpenUsageScreen();
  if (accounts.length === 0) return null;
  const attention = attentionCount(accounts);
  const countLabel =
    attention > 0
      ? `${attention} of ${accounts.length} accounts need attention`
      : `${accounts.length} accounts`;
  return (
    <GlobalCard
      kind="globalQuota"
      title={accounts.length === 1 ? "Quota" : "Quotas"}
      icon={HEADING_ICON}
      count={accounts.length}
      countLabel={countLabel}
      testID="global-quota-card"
    >
      <QuotaAccountList accounts={accounts} serverId={serverId} view={view} now={now} />
      <QuotaFooter view={view} onOpenUsage={openUsage} />
    </GlobalCard>
  );
}
