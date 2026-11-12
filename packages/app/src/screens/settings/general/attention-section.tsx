import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { OwnerUnlockDialog } from "@/components/settings/owner-lock";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import {
  useInstallationOwnerClient,
  useInstallationSystemModel,
} from "@/execution-installation/panel";
import { useOwnerAccess } from "@/execution-installation/owner-access";
import { useInstallationUpgradeStatus } from "@/execution-installation/use-installation-upgrades";
import { SYSTEM_HEALTH_ANCHOR_ID, type SettingsJumpTarget } from "../settings-jump";
import { systemHealthItems } from "../system/health-model";
import { publishHealthExtras, useHealthListMounted } from "../system/health-extras";
import { useQueryClient } from "@tanstack/react-query";
import { useSystemHealthRows, type AttentionItem } from "../system/system-health-rows";

const NO_SUBSCRIPTION = () => () => {};
const NO_STATE = () => null;

/** What the installation reports as needing the owner, from the same state the button reads. */
function useInstallationItems() {
  const model = useInstallationSystemModel();
  const state = useSyncExternalStore(
    model?.subscribe ?? NO_SUBSCRIPTION,
    model?.getState ?? NO_STATE,
    model?.getState ?? NO_STATE,
  );
  const upgrades = useInstallationUpgradeStatus(useInstallationOwnerClient());
  return systemHealthItems(state, upgrades.data?.upgrades);
}

/** Says what a locked installation hides, with the Unlock that reveals it. Not a problem row. */
function LockedHealthRow() {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <SettingsRow
      label="Provider and settings checks"
      hint="Locked. Unlock to see provider and settings items."
      testID="settings-attention-locked"
    >
      <Button variant="outline" size="sm" onPress={show} accessibilityLabel="Unlock settings">
        Unlock
      </Button>
      <OwnerUnlockDialog visible={open} onClose={close} />
    </SettingsRow>
  );
}

function AttentionRow({
  item,
  onFix,
}: {
  item: AttentionItem;
  onFix: (target: SettingsJumpTarget) => void;
}) {
  const fix = useCallback(
    () => onFix({ pane: item.pane, settingId: item.settingId }),
    [item.pane, item.settingId, onFix],
  );
  return (
    <SettingsRow label={item.label} hint={item.hint} testID={`settings-attention-${item.id}`}>
      <Button
        variant="outline"
        size="sm"
        onPress={fix}
        accessibilityLabel={`Fix ${item.label}`}
        testID={`settings-attention-${item.id}-fix`}
      >
        Fix
      </Button>
    </SettingsRow>
  );
}

// The list is a labelled region, so focus moved here by "System needs attention" reads its name.
const regionProps = isWeb
  ? ({ role: "region", "aria-label": "System health" } as const)
  : ({ accessibilityLabel: "System health" } as const);

/**
 * Everything that needs the owner, item by item, at the top of System. Each row names the
 * problem, its current status, and a Fix that jumps to the control that resolves it. It always
 * renders so System never shifts when checks finish: checking, one quiet "All good" row, or the
 * items. "System needs attention" lands on and focuses this list.
 */
export function SystemHealthSection({ onFix }: { onFix: (target: SettingsJumpTarget) => void }) {
  const locked = useOwnerAccess().status === "locked";
  const installationItems = useInstallationItems();
  const items = useSystemHealthRows({ installationItems, locked });
  // Hand the sidebar button the rows it cannot compute without the settings queries.
  const extraIds = items
    ?.filter((item) => !installationItems.some((entry) => entry.id === item.id))
    .map((item) => item.id)
    .join("|");
  const queryClient = useQueryClient();
  useHealthListMounted();
  useEffect(() => {
    if (extraIds !== undefined)
      publishHealthExtras(extraIds ? extraIds.split("|") : [], queryClient);
  }, [extraIds, queryClient]);
  let rows;
  if (items === null)
    rows = (
      <SettingsRow
        label="Checking..."
        hint="Looking for anything that needs you."
        testID="settings-attention-checking"
      />
    );
  else if (items.length === 0 && !locked)
    rows = (
      <SettingsRow
        label="All good"
        hint="Nothing needs your attention."
        testID="settings-attention-clear"
      />
    );
  else rows = items.map((item) => <AttentionRow key={item.id} item={item} onFix={onFix} />);
  // While locked, say what is hidden instead of claiming all is well.
  const lockedRow = locked && items !== null ? <LockedHealthRow key="locked" /> : null;
  return (
    <SettingsSection title="Health" testID="settings-attention">
      <View {...regionProps} nativeID={SYSTEM_HEALTH_ANCHOR_ID} testID="settings-health-list">
        <SettingsCard>
          {rows}
          {lockedRow}
        </SettingsCard>
      </View>
    </SettingsSection>
  );
}
