### Fixes

- Claude full sign-in accounts should stop disconnecting. The coordinator is now the only process that renews each sign-in by default, so Host agents and the coordinator no longer refresh the same token. Existing accounts move over on their next check without signing in again.
- The coordinator retries a failed renewal every 30 seconds in the token's last minutes and renews at once after the computer wakes from sleep.
- When the coordinator cannot renew an account before its token expires, Settings shows that account as needing sign-in, with Reconnect on its row, instead of failing silently.
- A refresh that does not renew the token now records whether the sign-in was missing, unreadable or had no expiry, and how the refresh command failed. No token or command output is logged.

### Maintenance

- Custody can be turned off for one account with `claude-oauth/authority-off/<hash>` or for all with `claude-oauth/authority-disabled`. The providers guide covers both and the downgrade order.

## Maintenance review

Coordinator custody for Claude full sign-in is now on by default with a per-account off marker; the global kill switch is unchanged. Added 30-second retries in the lead window, renewal on wake from sleep, stripping of expired unrecognized refresh tokens beside a live authority, refresh diagnostics, a `refreshStalled` connection status and Reconnect for named accounts the coordinator reports as needing sign-in. Updated the providers guide and the subscription accounts entry. Focused tests pass; live refresh cycles on the installation remain to be observed. README overview and onboarding are unchanged.
