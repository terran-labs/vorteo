### Fixes

- Claude accounts that use full sign-in should stop disconnecting. Host agents and the coordinator could all refresh the same login, and a refresh token used twice can make Claude cancel the whole sign-in. The coordinator now keeps each login in its own directory that no agent uses and is the only process that refreshes it. Host agents get the current access token, as Dev already did, and existing logins move over automatically the first time the coordinator reads them.
- The coordinator log now records every Claude refresh attempt with its outcome, old and new expiry, duration and failure reason, and warns when an access token is about to expire without a successful refresh. No token is ever logged.

### Maintenance

- Tests cover moving an existing login (including the macOS Keychain order), running the move again, dropping an older leftover token, waiting near expiry, rollback, and a runtime case where concurrent triggers refresh once, only in the coordinator's directory, while the agent's files never hold a refresh token.

## Maintenance review

Host-owned Claude refresh now keeps each full sign-in grant in a coordinator-only authority directory, adopts any refresh token it finds in an account directory, and writes access-only copies for Host agents. Rollback is an `authority-disabled` marker in the coordinator state directory. Updated the full sign-in section of the providers guide and the subscription accounts entry in the customizations inventory. Focused tests and a Keychain check with throwaway items and fake tokens pass; a live refresh on the installation is pending. README overview and onboarding are unchanged.
