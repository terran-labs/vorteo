### Fixes

- Factory account picks now treat a usage reading without its own timestamp as read when its usage list was, so fresh accounts qualify instead of every pick falling back to the configured default.

## Maintenance review

Fix for quota-aware Factory accounts found in the post-install live check: the daemon glue dates readings by their usage list, matching quota reserve polling. Source only; not installed. README overview and onboarding are unchanged.
