import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { taskCardStyles, TASK_CARD_BODY_INSET } from "@/agent-stream/task-card-styles";
import {
  sectionDividerBleedStyle,
  useSectionDividerBleed,
} from "@/components/sidebar/global-card-shell";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";
import { bestChoice, rankedRows, type BestChoice, type RankedAccount } from "./best-account";
import { providerConnectionAction } from "./connection-action";
import { formatAmount } from "./format";
import type { QuotaAccount, QuotaBalanceRow, QuotaWindowRow } from "./global-quota";
import { LIMIT_OBSERVATION_DETAIL_ID } from "./quota-reading";
import { ProviderReconnectControl } from "./reconnect-control";
import { ProviderResetControl } from "./reset-control";
import { formatCountdown, formatResetMoment, formatUtcMoment } from "./reset-time";
import { dayTicks, runwayDescription, runwayLabel, runwaySummary } from "./runway";
import { DayAxis, RunwayLane } from "./runway-lane";
import { deriveTone } from "./tone";
import type { ProviderUsageTone, ProviderUsageView } from "./types";

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const Down = withUnistyles(ChevronDown, iconColor);
const Right = withUnistyles(ChevronRight, iconColor);
const OBSERVED_NOTE = "From last limit message";

type Tone = "ok" | "warning" | "danger" | "stale";

/** Matches the usage tiles: a provider's own tone wins, else tone.ts thresholds. */
function toneOf(
  remaining: number | null,
  { stale = false, tone = null }: { stale?: boolean; tone?: ProviderUsageTone | null } = {},
): Tone {
  if (stale) return "stale";
  const derived = tone ?? deriveTone(remaining === null ? null : 100 - remaining);
  if (derived === "danger" || derived === "warning") return derived;
  return "ok";
}

/** The card body: the account to use next, a shared day axis and one runway row per account. */
export function QuotaAccountList({
  accounts,
  serverId,
  view,
  now,
}: {
  accounts: readonly QuotaAccount[];
  serverId: string | null;
  view: ProviderUsageView;
  now: number;
}) {
  const rows = useMemo(() => rankedRows(accounts, now), [accounts, now]);
  const choice = useMemo(() => bestChoice(rows, now), [rows, now]);
  const ticks = useMemo(() => dayTicks(now), [now]);
  return (
    <View style={styles.list}>
      {choice ? <BestNow choice={choice} /> : null}
      <View style={[taskCardStyles.proseInset, styles.axis]}>
        <DayAxis ticks={ticks} />
      </View>
      {rows.map((row, index) => (
        <AccountRow
          key={row.account.providerId}
          row={row}
          first={index === 0}
          only={rows.length === 1}
          serverId={serverId}
          view={view}
          now={now}
        />
      ))}
    </View>
  );
}

function BestNow({ choice }: { choice: BestChoice }) {
  const { best, next, waiting } = choice;
  return (
    <View style={styles.best} testID="global-quota-best">
      <Text style={styles.bestLabel}>{waiting ? "Next available" : "Best now"}</Text>
      <Text style={styles.bestName} numberOfLines={1}>
        {best.account.name}
        {best.account.plan ? (
          <Text style={styles.bestPlan}>{` · ${best.account.plan}`}</Text>
        ) : null}
      </Text>
      <Text style={styles.bestReason} numberOfLines={2}>
        {best.reason}
      </Text>
      {next ? (
        <Text style={styles.bestThen} numberOfLines={1} testID="global-quota-best-then">
          Then <Text style={styles.bestThenName}>{next.account.name}</Text>
          {`, ${next.reason.charAt(0).toLowerCase()}${next.reason.slice(1)}`}
        </Text>
      ) : null}
    </View>
  );
}

function useConnection(account: QuotaAccount, serverId: string | null, view: ProviderUsageView) {
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((entry) => entry.providerId === account.providerId)
      : undefined;
  const action = providerConnectionAction({
    providerId: account.providerId,
    providers: config?.providers,
    usage,
    snapshot: entries?.find((entry) => entry.provider === account.providerId),
  });
  return { action, usage };
}

function AccountRow({
  row,
  first,
  only,
  serverId,
  view,
  now,
}: {
  row: RankedAccount;
  first: boolean;
  only: boolean;
  serverId: string | null;
  view: ProviderUsageView;
  now: number;
}) {
  const { account, runway } = row;
  const choice = usePanelStore((state) => state.quotaAccountExpanded[account.providerId]);
  // A lone account has nothing to make room for; otherwise the lane is the summary.
  const expanded = choice ?? only;
  const toggle = useCallback(() => {
    usePanelStore.getState().setQuotaAccountExpanded(account.providerId, !expanded);
  }, [account.providerId, expanded]);
  const toggleState = useMemo(() => ({ expanded }), [expanded]);
  const { action, usage } = useConnection(account, serverId, view);
  const bleed = useSectionDividerBleed();
  const Chevron = expanded ? Down : Right;
  const label = runwayLabel(account, runway);
  const summary = runwaySummary(account, runway, now);
  const description = `${account.name}, next 7 days: ${runwayDescription(runway, now)}`;
  return (
    <View
      style={[
        styles.account,
        taskCardStyles.proseInset,
        !first && [taskCardStyles.separator, sectionDividerBleedStyle(bleed, TASK_CARD_BODY_INSET)],
      ]}
      testID={`global-quota-account-${account.providerId}`}
    >
      <View style={styles.header}>
        <Pressable
          onPress={toggle}
          style={styles.headerToggle}
          accessibilityRole="button"
          accessibilityState={toggleState}
          accessibilityLabel={`${account.name}, ${summary}`}
          testID={`global-quota-toggle-${account.providerId}`}
        >
          <Chevron size={12} />
          <Text style={styles.name} numberOfLines={1}>
            {account.name}
          </Text>
          {label ? (
            <Text
              style={[styles.label, label.tone === "danger" && styles.danger]}
              testID={`global-quota-label-${account.providerId}`}
            >
              {label.text}
            </Text>
          ) : null}
          {account.running > 0 ? (
            <Text
              style={styles.running}
              accessibilityLabel={`${account.running} ${account.running === 1 ? "agent" : "agents"} running`}
            >
              ● {account.running}
            </Text>
          ) : null}
        </Pressable>
        {action ? (
          <ProviderReconnectControl
            usage={usage}
            serverId={serverId}
            providerId={account.providerId}
            name={account.name}
          />
        ) : null}
      </View>
      <Pressable onPress={toggle} focusable={false} style={styles.indent}>
        <RunwayLane
          runway={runway}
          label={description}
          testID={`global-quota-lane-${account.providerId}`}
        />
        <Text
          style={styles.summary}
          numberOfLines={1}
          testID={`global-quota-summary-${account.providerId}`}
        >
          {summary}
        </Text>
      </Pressable>
      {expanded ? (
        <AccountDetail account={account} now={now} serverId={serverId} canReset={!action} />
      ) : null}
    </View>
  );
}

/** Signed-out accounts show Reconnect in their header instead of reset credits. */
function AccountDetail({
  account,
  now,
  serverId,
  canReset,
}: {
  account: QuotaAccount;
  now: number;
  serverId: string | null;
  canReset: boolean;
}) {
  let status = account.status;
  if (account.disconnected && account.windows.length && account.fetchedAt) {
    status = `Account disconnected. Showing last known usage from ${formatResetMoment(account.fetchedAt)}.`;
  }
  return (
    <View
      style={[styles.indent, styles.detail]}
      testID={`global-quota-detail-${account.providerId}`}
    >
      {status ? <Text style={styles.status}>{status}</Text> : null}
      {account.observed ? (
        <Text style={styles.moment} testID={`global-quota-observed-${account.providerId}`}>
          {OBSERVED_NOTE}
        </Text>
      ) : null}
      {account.windows.map((window) => (
        <WindowRow
          key={window.id}
          window={window}
          account={account}
          stale={account.disconnected}
          now={now}
        />
      ))}
      {account.balances.map((balance) => (
        <BalanceRow key={balance.id} balance={balance} now={now} />
      ))}
      {account.plan ? <Fact label="Plan" value={account.plan} /> : null}
      {/* The observation note above already says where the reading came from. */}
      {account.details
        .filter((detail) => detail.id !== LIMIT_OBSERVATION_DETAIL_ID)
        .map((detail) => (
          <Fact key={detail.id} label={detail.label} value={detail.value} tone={detail.tone} />
        ))}
      {account.source ? <Fact label="Source" value={account.source} /> : null}
      {canReset ? (
        <View style={styles.actions}>
          <ProviderResetControl
            serverId={serverId}
            providerId={account.providerId}
            name={account.name}
            compact
          />
        </View>
      ) : null}
    </View>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: ProviderUsageTone }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[
          styles.factValue,
          tone === "warning" && styles.warning,
          tone === "danger" && styles.danger,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function Meter({ remaining, tone, label }: { remaining: number; tone: Tone; label: string }) {
  const fill = useMemo(
    () => [
      styles.fill,
      tone === "warning" && styles.warningFill,
      tone === "danger" && styles.dangerFill,
      tone === "stale" && styles.staleFill,
      { width: `${remaining}%` as `${number}%` },
    ],
    [remaining, tone],
  );
  const value = useMemo(() => ({ min: 0, max: 100, now: Math.round(remaining) }), [remaining]);
  return (
    <View
      style={styles.meter}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={value}
    >
      <View style={fill} />
    </View>
  );
}

function WindowRow({
  window,
  account,
  stale,
  now,
}: {
  window: QuotaWindowRow;
  account: QuotaAccount;
  stale: boolean;
  now: number;
}) {
  const tone = toneOf(window.remaining, { stale, tone: window.tone });
  const passed = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
  const notStarted =
    window.resetsAt === null && window.remaining !== null && window.remaining >= 99.5;
  return (
    <View testID={`global-quota-window-${account.providerId}-${window.id}`}>
      <View style={styles.windowTop}>
        <Text style={styles.windowLabel} numberOfLines={1}>
          {window.label}
          {window.separate ? <Text style={styles.windowNote}> · separate</Text> : null}
        </Text>
        <Text
          style={[
            styles.pct,
            window.limiting && styles.pctLimiting,
            tone === "warning" && styles.warning,
            tone === "danger" && styles.danger,
          ]}
        >
          {window.remaining === null ? "Unknown" : `${Math.round(window.remaining)}%`}
        </Text>
      </View>
      {window.remaining !== null ? (
        <Meter
          remaining={window.remaining}
          tone={tone}
          label={`${account.name} ${window.label} remaining`}
        />
      ) : null}
      {notStarted ? (
        <Text style={styles.moment}>Not started. Opens with the first message.</Text>
      ) : (
        <MomentLine
          prefix={passed ? "Reset" : "Resets"}
          suffix={passed && stale ? " (awaiting refresh)" : ""}
          iso={window.resetsAt}
          now={now}
        />
      )}
      {window.runsOutAt && !stale ? (
        <MomentLine
          prefix="At this pace, runs out"
          iso={window.runsOutAt}
          now={now}
          warning
          testID={`global-quota-pace-${account.providerId}-${window.id}`}
        />
      ) : null}
    </View>
  );
}

function BalanceRow({ balance, now }: { balance: QuotaBalanceRow; now: number }) {
  if (balance.remaining === null) return null;
  if (balance.limit === null) {
    return (
      <Fact
        label={balance.label}
        value={`${formatAmount(balance.remaining, balance.unit)}${unitSuffix(balance)} left`}
      />
    );
  }
  const remainingPct = Math.max(0, Math.min(100, (100 * balance.remaining) / balance.limit));
  const tone = toneOf(remainingPct);
  return (
    <View>
      <View style={styles.windowTop}>
        <Text style={styles.windowLabel} numberOfLines={1}>
          {balance.label}
        </Text>
        <Text
          style={[
            styles.pct,
            tone === "warning" && styles.warning,
            tone === "danger" && styles.danger,
          ]}
        >
          {formatAmount(balance.remaining, balance.unit)}
          <Text style={styles.pctUnit}>
            {` of ${formatAmount(balance.limit, balance.unit)}${unitSuffix(balance)}`}
          </Text>
        </Text>
      </View>
      <Meter remaining={remainingPct} tone={tone} label={`${balance.label} remaining`} />
      <MomentLine prefix="Renews" iso={balance.resetsAt} now={now} />
    </View>
  );
}

function unitSuffix(balance: QuotaBalanceRow): string {
  if (balance.unit === "credits") return " credits";
  if (balance.unit === "requests") return " requests";
  return "";
}

/** An absolute moment with its countdown; hovering or pressing shows the same moment in UTC. */
function MomentLine({
  prefix,
  suffix = "",
  iso,
  now,
  warning = false,
  testID,
}: {
  prefix: string;
  suffix?: string;
  iso: string | null;
  now: number;
  warning?: boolean;
  testID?: string;
}) {
  const moment = formatResetMoment(iso);
  if (!moment) {
    return prefix === "Resets" ? <Text style={styles.moment}>Reset time unavailable</Text> : null;
  }
  const countdown = formatCountdown(iso, now);
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <View style={styles.momentRow} testID={testID}>
          <Text style={[styles.moment, warning && styles.warning]}>
            {`${prefix} ${moment}${suffix}`}
            {countdown ? (
              // Non-breaking spaces keep the countdown on one line when the moment wraps.
              <Text style={styles.countdown}>{` · ${countdown.replace(/ /g, " ")}`}</Text>
            ) : null}
          </Text>
        </View>
      </TooltipTrigger>
      <TooltipContent maxWidth={320}>
        <TooltipText label={moment} description={formatUtcMoment(iso) ?? undefined} />
      </TooltipContent>
    </Tooltip>
  );
}

const INDENT = 16;

const styles = StyleSheet.create((theme) => ({
  list: { paddingTop: theme.spacing[1] },
  best: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.surface1,
    gap: 2,
  },
  bestLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  bestName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  bestPlan: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.normal },
  bestReason: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
    fontVariant: ["tabular-nums"],
  },
  bestThen: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm - 1,
    fontVariant: ["tabular-nums"],
  },
  bestThenName: { color: theme.colors.foregroundMuted },
  axis: { paddingLeft: INDENT },
  account: { gap: theme.spacing[1], paddingVertical: theme.spacing[2] + 2 },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minWidth: 0 },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    marginRight: "auto",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  label: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
  },
  running: {
    flexShrink: 0,
    marginLeft: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
    fontVariant: ["tabular-nums"],
  },
  indent: { marginLeft: INDENT },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
    fontVariant: ["tabular-nums"],
  },
  detail: { gap: theme.spacing[3], paddingTop: theme.spacing[2] },
  status: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm - 1 },
  windowTop: { flexDirection: "row", alignItems: "baseline", gap: theme.spacing[1] },
  windowLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
  },
  windowNote: { color: theme.colors.foregroundExtraMuted },
  pct: {
    marginLeft: "auto",
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
    fontVariant: ["tabular-nums"],
  },
  pctLimiting: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  pctUnit: { color: theme.colors.foregroundExtraMuted },
  meter: {
    height: 3,
    borderRadius: 1.5,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
    marginVertical: 4,
  },
  fill: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.55,
  },
  warningFill: { backgroundColor: theme.colors.statusWarning, opacity: 1 },
  dangerFill: { backgroundColor: theme.colors.destructive, opacity: 1 },
  staleFill: { backgroundColor: theme.colors.foregroundExtraMuted },
  momentRow: { alignSelf: "flex-start", maxWidth: "100%" },
  moment: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm - 2,
    fontVariant: ["tabular-nums"],
  },
  countdown: { color: theme.colors.foregroundExtraMuted },
  fact: { flexDirection: "row", gap: theme.spacing[2] },
  factLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm - 1,
  },
  factValue: {
    flexShrink: 0,
    maxWidth: "65%",
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
  },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  warning: { color: theme.colors.statusWarning },
  danger: { color: theme.colors.destructive },
}));
