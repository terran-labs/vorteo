import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AgentUsageSection, useAgentUsage } from "@/usage";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useSessionStore } from "@/stores/session-store";
import type { SessionCost } from "./context-window-meter.utils";

import { ContextBreakdown } from "./context-breakdown/view";
import { useContextBreakdown } from "./context-breakdown/use-context-breakdown";

interface ContextWindowDetailsProps {
  serverId: string;
  agentId: string;
  percentage: number;
  usedTokens: number;
  maxTokens: number;
  sessionCost: SessionCost | null;
  /** The tooltip titles itself; the sheet's header carries the title instead. */
  showTitle: boolean;
  /**
   * Only the sheet and the details card can be pressed, so only they show Refresh buttons and
   * expandable breakdown groups.
   */
  refreshable: boolean;
}

/**
 * What the context window meter opens and the Context details card shows: how full the window
 * is and what fills it, then the usage of the account the agent runs under. The wide tooltip, the compact
 * sheet and the card all render it, so they always match.
 *
 * The breakdown, account usage and plan usage load independently. Until all three settle, one
 * loading pulse stands in for them, so the details appear together instead of as three
 * separate loading sentences.
 */
export function ContextWindowDetails({
  serverId,
  agentId,
  percentage,
  usedTokens,
  maxTokens,
  sessionCost,
  showTitle,
  refreshable,
}: ContextWindowDetailsProps) {
  const { t } = useTranslation();
  const breakdown = useContextBreakdown(serverId, agentId);
  const accountUsage = useAgentUsage(serverId, agentId);
  // The agent's own account answers for its quotas. Plan usage is matched by provider alone, so
  // it can show another login's quotas; it stands in only when the host reports no account.
  const showPlanUsage = accountUsage.kind === "none";
  // Read plan usage only when it is shown, from the shared cache: every forced read polls each
  // Claude login's usage endpoint, which rate-limits the account card's own reads.
  const { view: planUsage } = useProviderUsage(serverId, { enabled: showPlanUsage });
  const provider = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.provider,
  );
  const loading =
    breakdown.kind === "loading" ||
    accountUsage.kind === "loading" ||
    (showPlanUsage && planUsage.kind === "loading");

  return (
    <>
      {showTitle ? <Text style={styles.title}>{t("contextWindow.title")}</Text> : null}
      <ContextBreakdown
        view={breakdown}
        loading={loading}
        percentage={percentage}
        usedTokens={usedTokens}
        maxTokens={maxTokens}
        sessionCost={sessionCost}
        interactive={refreshable}
      />
      {loading ? null : (
        <>
          <AgentUsageSection
            agentId={agentId}
            serverId={serverId}
            view={accountUsage}
            refreshable={refreshable}
          />
          {showPlanUsage ? (
            <ProviderUsageTooltipSection view={planUsage} activeProviderId={provider} />
          ) : null}
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
