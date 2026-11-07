### Fixes

- Claude full sign-in accounts can now have a single refresher. Host agents and the coordinator could all refresh the same login, and a refresh token used twice can make Claude cancel the whole sign-in. An account opted into coordinator custody keeps its login in a coordinator-only directory, the coordinator alone refreshes it, and Host agents get the current access token, as Dev already did. Custody is off by default and can be turned on and off per account; turning it off returns the login to the account's own directory.
- The coordinator log now records every Claude refresh attempt with its outcome, old and new expiry, duration and failure reason, and warns when an access token is about to expire without a successful refresh. No token is ever logged.

### Maintenance

- Tests cover moving an existing login (including the macOS Keychain order), running the move again, removing a token the coordinator already held, adopting any new sign-in, waiting near expiry or while an agent's CLI holds its refresh lock, rollback, accounts without custody keeping the previous behavior, renewal continuing when the agent copy cannot be written, and concurrent triggers refreshing once, only in the coordinator's directory.

## Maintenance review

Host-owned Claude refresh gains opt-in coordinator custody, enabled per account with an `authority-enabled` marker in the coordinator state directory and off by default. In custody the grant lives in a coordinator-only authority directory, any new refresh token found in the account directory is adopted under the CLI's refresh and storage locks, and Host agents receive access-only copies. Removing the marker or creating `authority-disabled` returns the grant; the providers guide documents the downgrade order. Refresh logging applies to every account. Updated the full sign-in section of the providers guide and the subscription accounts entry in the customizations inventory. Focused tests and a Keychain check with throwaway items and fake tokens pass; a live refresh on the installation is pending. README overview and onboarding are unchanged.
