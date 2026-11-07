### Fixes

- An interrupted Factory claim release is reconciled before it is archived: the daemon retries the delete if the branch is still there, abandons the release if the owner pushed, and keeps that recovery record when Factory is turned off and on.

## Maintenance review

Review fix for multi-installation Factory claims: release recovery checks the branch before archiving, and enable preserves pending releases. Source only; not installed. README overview and onboarding are unchanged.
