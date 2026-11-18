### Fixes

- Opening a closed thread that needed attention no longer starts its provider just to clear the attention marker; the stored record is updated instead, and the thread loads on its first prompt.

## Maintenance review

Clearing attention on an unloaded agent updates and dispatches its stored record, and the clear response includes the stored snapshot. The earlier saved-history timeline work on this branch was dropped as duplicating the open daemon history memory change, which also restores provider subagents from saved history. No inventory entry changes; the runtime residency section records the behavior. Not installed. README overview and onboarding are unchanged.
