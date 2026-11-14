import { createContext, useContext } from "react";

/**
 * What the settings page is pointing at, for disclosures inside a pane: the pane rendering them,
 * the pane the latest jump targets with that jump's `nonce`, and the panes a search matches rows
 * in. The scroll page provides it per pane; outside the page nothing ever opens on its own.
 */
export interface SettingsRevealState {
  pane: string | null;
  targetPane: string | null;
  /** The catalog entry the latest jump lands on, when it names one. */
  targetSettingId: string | null;
  nonce: number;
  /** When the latest jump was issued, so a disclosure mounted long after it ignores it. */
  issuedAt: number;
  searchPanes: ReadonlySet<string>;
  /** Catalog entries the current search matches. */
  searchSettingIds: ReadonlySet<string>;
}

const NO_REVEAL: SettingsRevealState = {
  pane: null,
  targetPane: null,
  targetSettingId: null,
  nonce: 0,
  issuedAt: 0,
  searchPanes: new Set(),
  searchSettingIds: new Set(),
};

export const SettingsRevealContext = createContext<SettingsRevealState>(NO_REVEAL);

/** How long after a jump a newly mounted disclosure still treats it as aimed at itself. */
export const REVEAL_FRESH_MS = 5000;

/** Whether the latest jump is recent enough to open something that only now mounted. */
export function isFreshReveal(state: SettingsRevealState, now = Date.now()): boolean {
  return state.nonce > 0 && now - state.issuedAt < REVEAL_FRESH_MS;
}

/**
 * The jump or search aimed at one pane, for content that opens its own disclosure or dialog to
 * reveal a control, such as an environment's Edit dialog. `settingId` is the catalog entry the
 * jump lands on (`environment:<serverId>` for one environment); open when `nonce` changes and
 * `fresh` is true, and look for the row by its label once open.
 */
export function useSettingsRevealTarget(paneId: string): {
  settingId: string | null;
  nonce: number;
  fresh: boolean;
  searching: boolean;
} {
  const state = useContext(SettingsRevealContext);
  const aimed = state.targetPane === paneId;
  return {
    settingId: aimed ? state.targetSettingId : null,
    nonce: aimed ? state.nonce : 0,
    fresh: aimed && isFreshReveal(state),
    searching: state.searchPanes.has(paneId),
  };
}
