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
import { upgradesStillOpen } from "@/execution-installation/installation-upgrades-model";
import { healthCardAnchorId, revealHealthCard } from "@/execution-installation/health-cards";
import { SYSTEM_HEALTH_ANCHOR_ID, type SettingsJumpTarget } from "../settings-jump";
import { systemHealthItems } from "../system/health-model";
import { publishHealthExtras, useHealthListMounted } from "../system/health-extras";
import { useQueryClient } from "@tanstack/react-query";
import {
  installationHealthRows,
  useSystemHealthRows,
  type AttentionItem,
} from "../system/system-health-rows";

const NO_SUBSCRIPTION = () => () => {};
const UNLOCK_REPLAY_MS = 10_000;
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
  return {
    items: systemHealthItems(state, upgradesStillOpen(upgrades.data)),
    unlocked: state?.unlocked === true,
  };
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

/**
 * Opens the card that resolves a row: expands the section holding it, then jumps there. The
 * settings page waits for the card to render, scrolls it into view and focuses its first
 * control. Rows without a card keep their catalog target.
 */
function openFix(item: AttentionItem, onFix: (target: SettingsJumpTarget) => void): void {
  if (item.card && item.cardHost) {
    revealHealthCard(item.card, item.cardHost);
    // A sheet takes focus itself; scrolling the page under it would pull focus back out.
    if (item.cardInSheet) return;
    onFix({
      pane: item.pane,
      anchorId: healthCardAnchorId(item.cardHost, item.card),
      focus: true,
    });
    return;
  }
  onFix({ pane: item.pane, settingId: item.settingId });
}

function AttentionRow({
  item,
  onFix,
}: {
  item: AttentionItem;
  onFix: (item: AttentionItem) => void;
}) {
  const fix = useCallback(() => onFix(item), [item, onFix]);
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
// The page lands a region that starts with its own heading at the top, without extra room.
const HEADING_ANCHOR = { settingsJump: "top" } as const;
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
  // A Fix whose card needs owner access waits here while the unlock dialog is open. Cancelling
  // drops it, so nothing expands and the page stays where it was.
  const [awaitingUnlock, setAwaitingUnlock] = useState<AttentionItem | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const fix = useCallback(
    (item: AttentionItem) => {
      if (item.needsUnlock && locked) {
        setAwaitingUnlock(item);
        setUnlockOpen(true);
        return;
      }
      openFix(item, onFix);
    },
    [locked, onFix],
  );
  const closeUnlock = useCallback(() => setUnlockOpen(false), []);
  const installation = useInstallationItems();
  const installationItems = installation.items;
  useEffect(() => {
    if (unlockOpen || !awaitingUnlock) return;
    // The dialog closes itself once access unlocks; any other close is a cancel.
    if (locked) {
      setAwaitingUnlock(null);
      return;
    }
    // Locked rows only know public counts, such as which card, not which environment. Wait for
    // the unlocked rows, which load after access unlocks, then follow the row for the same card.
    // When none appears, the timer below drops the Fix: nothing there needs the owner any more.
    if (!installation.unlocked) return;
    const current = installationItems.find((item) => item.card === awaitingUnlock.card);
    if (!current) return;
    setAwaitingUnlock(null);
    openFix(installationHealthRows([current])[0], onFix);
  }, [awaitingUnlock, installation.unlocked, installationItems, locked, onFix, unlockOpen]);
  // A Fix still waiting for the unlocked rows after this long is dropped, not replayed later.
  useEffect(() => {
    if (!awaitingUnlock || unlockOpen) return;
    const timer = setTimeout(() => setAwaitingUnlock(null), UNLOCK_REPLAY_MS);
    return () => clearTimeout(timer);
  }, [awaitingUnlock, unlockOpen]);
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
  else rows = items.map((item) => <AttentionRow key={item.id} item={item} onFix={fix} />);
  // While locked, say what is hidden instead of claiming all is well.
  const lockedRow = locked && items !== null ? <LockedHealthRow key="locked" /> : null;
  // The anchor holds the Health heading too: "System needs attention" lands it at the top.
  return (
    <View {...regionProps} nativeID={SYSTEM_HEALTH_ANCHOR_ID} dataSet={HEADING_ANCHOR}>
      <SettingsSection title="Health" testID="settings-attention">
        <View testID="settings-health-list">
          <SettingsCard>
            {rows}
            {lockedRow}
          </SettingsCard>
          <OwnerUnlockDialog visible={unlockOpen} onClose={closeUnlock} />
        </View>
      </SettingsSection>
    </View>
  );
}
