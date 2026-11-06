import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { quotaReading, resetDescription } from "@/provider-usage/quota-reading";
import { formatPct } from "@/provider-usage/format";
import { ProviderResetControl } from "@/provider-usage/reset-control";
import type { ProviderUsageView } from "@/provider-usage/types";
import { profileTileStyles } from "./profile-selector-tile";

const OBSERVED_NOTE = "From last limit message";

interface UsageProps {
  view: ProviderUsageView;
  providerId: string;
  now: number;
  compact?: boolean;
}

/** Refresh progress shows as a ring around the account icon, not in this badge. */
export function AccountUsageBadge({ view, providerId, now, compact = false }: UsageProps) {
  const { window, statusLabel, prepaidLabel } = quotaReading(view, providerId, now);
  const critical = Boolean(window && window.remainingPct < 5);
  const meterValue = useMemo(
    () => ({ min: 0, max: 100, now: window?.remainingPct ?? 0 }),
    [window?.remainingPct],
  );
  return (
    <View style={styles.badge} testID={`preset-usage-${providerId}`}>
      {prepaidLabel ? (
        <Text
          style={[styles.remaining, styles.prepaid]}
          accessibilityLabel={[prepaidLabel, statusLabel].filter(Boolean).join(", ")}
        >
          {prepaidLabel}
        </Text>
      ) : null}
      {window && !prepaidLabel ? (
        <>
          <Text
            style={[styles.remaining, critical && styles.critical]}
            accessibilityLabel={`${formatPct(window.remainingPct)} left${statusLabel ? `, ${statusLabel}` : ""}`}
          >
            {formatPct(window.remainingPct)}
            {compact ? "" : " left"}
          </Text>
          {!compact ? (
            <View
              style={styles.track}
              accessibilityRole="progressbar"
              accessibilityLabel="Usage remaining"
              accessibilityValue={meterValue}
            >
              <View
                style={[
                  styles.fill,
                  critical && styles.criticalFill,
                  { width: `${window.remainingPct}%` },
                ]}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function AccountUsageDetails({
  view,
  providerId,
  now,
  serverId,
  name,
  localStatus,
}: UsageProps & {
  serverId: string | null;
  name: string;
  localStatus?: string;
}) {
  const { window, usage, statusLabel, authRecovery, prepaidLabel, observed } = quotaReading(
    view,
    providerId,
    now,
  );
  const reset = window ? resetDescription(usage, window) : null;
  const description = localStatus ?? reset ?? statusLabel;
  const observedNote = observed && !localStatus ? OBSERVED_NOTE : null;
  const prepaidStatus = Boolean(prepaidLabel && !localStatus);
  let prepaidDescription = "Using prepaid";
  if (statusLabel) prepaidDescription = "Prepaid (last known)";
  const accessibleDescription = [
    prepaidStatus && prepaidDescription,
    description,
    observedNote,
    window && statusLabel,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <>
      <Text
        style={profileTileStyles.subtitle}
        numberOfLines={1}
        accessibilityLabel={accessibleDescription}
      >
        {prepaidStatus ? <Text style={styles.prepaid}>● {prepaidDescription}</Text> : null}
        {prepaidStatus && description ? " · " : null}
        {description}
        {observedNote ? ` · ${observedNote}` : null}
      </Text>
      {!localStatus && !authRecovery ? (
        <View style={styles.reset}>
          <ProviderResetControl
            serverId={serverId}
            providerId={providerId}
            name={name}
            compact
            preloaded
          />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 0 },
  remaining: {
    fontSize: theme.fontSize.sm,
    lineHeight: Math.ceil(theme.fontSize.base * 1.25),
    color: theme.colors.foregroundMuted,
  },
  prepaid: { color: theme.colors.statusWarning },
  critical: { color: theme.colors.destructive },
  track: {
    width: 32,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
    overflow: "hidden",
  },
  fill: { height: "100%", backgroundColor: theme.colors.accent },
  criticalFill: { backgroundColor: theme.colors.destructive },
  reset: {
    justifyContent: "center",
    minHeight: Math.ceil(theme.fontSize.base * 1.25),
    flexShrink: 0,
  },
}));
