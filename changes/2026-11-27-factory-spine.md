### Maintenance

- The lean Factory reconcile loop can take a labeled issue through a pinned merge in a simulated repository. The merge gate requires checks, review and acceptance on the same commit and verifies the recorded approval before completing an interrupted merge.

## Maintenance review

The file ledger, stage derivation, dispatcher and merge gate run together in the integration test. The development daemon and scratch repository still need verification. Existing Factory projects continue using their current service.
