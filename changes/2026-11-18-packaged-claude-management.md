### Fixes

- Repair the packaged Claude management case to open the fixture account's connection action and check the shared sign-in panel at desktop and phone widths. Preserve owner unlock, disconnected state and zero authorization starts; preserve removed catalog entries and the primary connection, restore isolated settings after partial setup or assertion failures and wait for Host and Dev convergence.

- Retry fixture setup and cleanup once after a settings revision conflict, rebuilding the update from a fresh snapshot and preserving concurrent changes. Report HTTP status, known settings error messages and reasons, and plain owner-access refusals without exposing arbitrary response content. A packaged run confirmed a first-load time-zone write raced fixture creation; repaired packaged acceptance remains pending.

## Maintenance review

Updated the provider management inventory to distinguish sign-in from Environment access and record pending packaged acceptance. This changes test coverage only; product behavior, README overview and onboarding are unchanged. Builds must run both width-specific cases on the exact PR head.
