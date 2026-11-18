### Fixes

- Stall review counts a heartbeat or schedule as a wake only when its next run is within a day and it is not held for quota.

## Maintenance review

Follow-up to the independent review of the stall review tuning. A schedule held for quota can stay active with a next run time and never fire, and a weekly heartbeat would hide a stalled thread for a week; both now leave the thread reviewable. The filter lives in the daemon wiring and has no test of its own; the service-level skip is covered by the existing review scan test. The agent lifecycle guide is updated. README overview and onboarding are unchanged; no merge or installation is included.
