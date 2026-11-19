### Maintenance

- Persist daemon-owned checklist wake generations and claim receipts across snapshots and reloads. Reject stale observations, cancel generations on task changes and preserve eligibility after a refused claim.
- Refuse non-null wake-condition writes from every daemon mutation caller until the complete monitor is ready. Runtime monitoring and admission remain disabled and unadvertised.

## Maintenance review

Updated the checklist inventory and protocol compatibility guide for durable wake state and the central readiness guard. Existing wire and checklist recovery cases cover the new boundary without adding a suite. README overview and onboarding are unchanged because runtime wakes remain unavailable.
