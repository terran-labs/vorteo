import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { SettingsRowHeader } from "./row-header";
import { isFreshReveal, SettingsRevealContext } from "./reveal-context";

interface SettingsAdvancedGroupProps {
  title?: string;
  testID?: string;
  /**
   * Panes whose jumps and search hits open the group. Defaults to the pane it renders in; list
   * more when a section's single Advanced group holds rows indexed under another pane.
   */
  panes?: readonly string[];
  /**
   * Rows indexed under a pane outside `panes` that render inside the group, such as System's
   * domain and live development rows. Jumps and search hits on them open it too.
   */
  settingIds?: readonly string[];
  children: ReactNode;
}

/**
 * The one place a section keeps rarely used controls: a closed disclosure at the section's end.
 * A jump or search aimed at its pane opens it, so search results and deep links never land on a
 * hidden row. A search hit opens it only while the search lasts, and the reader can still close
 * it; a jump leaves it open. A jump opens a group mounted later only while the jump is fresh, so
 * an old deep link does not reopen groups inside dialogs.
 *
 * Once opened, the contents stay mounted while hidden, so state such as a one-time token shown
 * inside survives the group collapsing.
 */
export function SettingsAdvancedGroup({
  title = "Advanced",
  testID = "settings-advanced",
  panes,
  settingIds,
  children,
}: SettingsAdvancedGroupProps) {
  const reveal = useContext(SettingsRevealContext);
  const [open, setOpen] = useState(false);
  const owned = useCallback(
    (pane: string | null) => pane !== null && (panes ? panes.includes(pane) : pane === reveal.pane),
    [panes, reveal.pane],
  );
  const ownsSetting = useCallback(
    (id: string | null) => id !== null && Boolean(settingIds?.includes(id)),
    [settingIds],
  );
  const targeted = owned(reveal.targetPane) || ownsSetting(reveal.targetSettingId);
  const fresh = isFreshReveal(reveal);
  useEffect(() => {
    if (targeted && fresh) setOpen(true);
    // Each new jump is judged once, when its nonce arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targeted, reveal.nonce]);
  const searchHit =
    [...reveal.searchPanes].some(owned) || [...reveal.searchSettingIds].some(ownsSetting);
  // Closing a group a search opened holds until that search ends.
  const [dismissedForSearch, setDismissedForSearch] = useState(false);
  useEffect(() => {
    if (!searchHit) setDismissedForSearch(false);
  }, [searchHit]);
  const expanded = open || (searchHit && !dismissedForSearch);
  const toggle = useCallback(() => {
    if (expanded && searchHit) setDismissedForSearch(true);
    setOpen(!expanded);
  }, [expanded, searchHit]);
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (expanded) setEverOpened(true);
  }, [expanded]);
  const bodyStyle = useMemo(() => [styles.body, !expanded && styles.hidden], [expanded]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`.
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  return (
    // Open, the last revealed section's own margin ends the group.
    <View style={expanded ? undefined : settingsStyles.section} testID={testID}>
      <View style={settingsStyles.card}>
        <SettingsRowHeader
          label={title}
          onPress={toggle}
          expanded={expanded}
          accessibilityState={accessibilityState}
          webAccessibilityProps={webExpandedProps}
          testID={`${testID}-toggle`}
        />
      </View>
      {expanded || everOpened ? (
        <View
          style={bodyStyle}
          aria-hidden={!expanded}
          importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The revealed sections keep their own headings and cards below the disclosure.
  body: { marginTop: theme.spacing[4] },
  hidden: { display: "none" },
}));
