### Fixes

- Refuse onboarding, daemon password changes and config set/unset when the target is the implicit managed Host. Keep config reads and daemon status available.

## Maintenance review

Verified config registrations: get reads configuration; set and unset mutate it. Extended the existing fake-CLI installer test for these routes and onboarding while preserving explicit targets. README onboarding and earlier forwarding fixes remain unchanged.
