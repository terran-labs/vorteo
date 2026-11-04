import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { taskCardStyles, TASK_CARD_BODY_INSET } from "@/agent-stream/task-card-styles";
import {
  sectionDividerBleedStyle,
  useSectionDividerBleed,
} from "@/components/sidebar/global-card-shell";
import { quotaFreshness } from "./global-quota";
import type { RunwayState } from "./runway";
import { LaneSwatch } from "./runway-lane";
import type { ProviderUsageView } from "./types";

/** The freshness label counts seconds, so it ticks on its own between minute polls. */
const FRESHNESS_TICK_MS = 10_000;

interface KeyEntry {
  state: RunwayState | "reset";
  label: string;
}

const KEY_ENTRIES: readonly KeyEntry[] = [
  { state: "capacity", label: "Plan capacity" },
  { state: "low", label: "Running low" },
  { state: "credits", label: "Prepaid credits" },
  { state: "out", label: "Out of quota" },
  { state: "unknown", label: "Not known" },
  { state: "reset", label: "Reset" },
];

/** Freshness, the lane key and the link to the full Usage screen. */
export function QuotaFooter({
  view,
  onOpenUsage,
}: {
  view: ProviderUsageView;
  onOpenUsage: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS);
    return () => clearInterval(timer);
  }, [view]);
  const freshness = quotaFreshness(view, now);
  const bleed = useSectionDividerBleed();
  const [keyOpen, setKeyOpen] = useState(false);
  const toggleKey = useCallback(() => setKeyOpen((open) => !open), []);
  const keyState = useMemo(() => ({ expanded: keyOpen }), [keyOpen]);
  return (
    <View
      style={[
        taskCardStyles.proseInset,
        taskCardStyles.separator,
        sectionDividerBleedStyle(bleed, TASK_CARD_BODY_INSET),
        styles.footer,
      ]}
    >
      <View style={styles.row}>
        {freshness ? (
          <View style={styles.freshness} testID="global-quota-freshness">
            <View style={[styles.dot, freshness.stale && styles.staleDot]} />
            <Text style={[styles.muted, freshness.stale && styles.stale]} numberOfLines={1}>
              {freshness.label}
            </Text>
          </View>
        ) : (
          <View style={styles.freshness} />
        )}
        <Pressable
          onPress={toggleKey}
          accessibilityRole="button"
          accessibilityState={keyState}
          testID="global-quota-key-toggle"
          hitSlop={6}
        >
          <Text style={[styles.muted, keyOpen && styles.keyOpen]}>Key</Text>
        </Pressable>
        <Pressable
          onPress={onOpenUsage}
          accessibilityRole="link"
          testID="global-quota-open-usage"
          hitSlop={6}
        >
          <Text style={styles.link}>Open Usage</Text>
        </Pressable>
      </View>
      {keyOpen ? (
        <View style={styles.key} testID="global-quota-key">
          {KEY_ENTRIES.map((entry) => (
            <View key={entry.state} style={styles.keyEntry}>
              <LaneSwatch state={entry.state} />
              <Text style={styles.muted}>{entry.label}</Text>
            </View>
          ))}
          <Text style={[styles.muted, styles.zone]}>
            Lanes cover the next 7 days. Times in {Intl.DateTimeFormat().resolvedOptions().timeZone}
            .
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: { paddingVertical: theme.spacing[2], gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  freshness: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  staleDot: { backgroundColor: theme.colors.statusWarning },
  muted: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm - 1 },
  stale: { color: theme.colors.statusWarning },
  keyOpen: { color: theme.colors.foregroundMuted },
  link: { color: theme.colors.accent, fontSize: theme.fontSize.sm - 1 },
  key: { flexDirection: "row", flexWrap: "wrap", columnGap: theme.spacing[3], rowGap: 6 },
  keyEntry: { flexDirection: "row", alignItems: "center", gap: 6, width: "45%" },
  zone: { width: "100%", marginTop: 2 },
}));
