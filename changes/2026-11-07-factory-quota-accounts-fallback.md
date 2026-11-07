### Fixes

- Factory account picks fall back to the configured default when usage cannot be read and no stage profile is set, and a reviewer profile bound to the worker's account reports that no account qualifies instead of returning the avoided one.

## Maintenance review

Review fixes for quota-aware Factory accounts: the default-provider usage read falls back, and bound profiles honor the avoided account. Source only; not installed. README overview and onboarding are unchanged.
