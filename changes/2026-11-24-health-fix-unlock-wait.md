### Fixes

- A Health Fix started while locked now waits for the unlocked rows to load before following the row for its card, instead of being dropped when access unlocks a moment before the queues arrive (#639).

### Maintenance

- Request card status badges no longer read as settings rows in the catalog coverage test.

## Maintenance review

Review follow-up to the System Health Fix change; the System status and restart controls entry already describes the behavior. Interface only; not installed. README overview and onboarding are unchanged.
