import { accessProjectionDigest, ClaudeOAuthDeliveryError } from "./claude-oauth-delivery.js";
import type { ClaudeAccessProjection } from "./claude-oauth-delivery.js";
import {
  CLAUDE_REFRESH_LEAD_MS,
  claudeAccessProjection,
  needsHostRefresh,
  type ClaudeOAuthGrant,
} from "./claude-oauth-storage.js";
import {
  HostOwnedRefresher,
  HostRefreshStateSchema,
  type HostGrantAdapter,
  type HostRefresherPorts,
  type HostRefreshPolicy,
  type HostRefreshState,
} from "./host-owned-refresher.js";

export const ClaudeOAuthStateSchema = HostRefreshStateSchema;
export type ClaudeOAuthState = HostRefreshState;
export type ClaudeOAuthPolicy = HostRefreshPolicy;
export type ClaudeOAuthRefresherPorts = HostRefresherPorts<
  ClaudeOAuthGrant,
  ClaudeAccessProjection
>;

const CLAUDE_GRANTS: HostGrantAdapter<ClaudeOAuthGrant, ClaudeAccessProjection> = {
  refreshForHost: true,
  project: claudeAccessProjection,
  digest: accessProjectionDigest,
  needsRefresh: needsHostRefresh,
  leadMs: CLAUDE_REFRESH_LEAD_MS,
  error: () => new ClaudeOAuthDeliveryError(),
};

/**
 * Host-owned refresh for full sign-in Claude accounts. See HostOwnedRefresher.
 *
 * `cliRefresh` is off by default. The Host agents share the account's CLAUDE_CONFIG_DIR and
 * refresh it lazily, and a failed refresh by another CLI process erases the stored sign-in that
 * those agents use (Claude Code 2.1.285). Without it the coordinator never runs the refresh CLI:
 * it reads the account every five minutes and delivers whatever the agents renewed to Dev.
 */
export class ClaudeOAuthRefresher extends HostOwnedRefresher<
  ClaudeOAuthGrant,
  ClaudeAccessProjection
> {
  constructor(ports: ClaudeOAuthRefresherPorts, options: { cliRefresh?: boolean } = {}) {
    super(
      ports,
      options.cliRefresh === true ? CLAUDE_GRANTS : { ...CLAUDE_GRANTS, needsRefresh: () => false },
    );
  }
}
