### Fixes

- Main CI's server tests pass again: a Factory account-choice test now names a primary connection. Since the primary connection change, a standalone daemon launches only with a chosen primary connection, and the test still assumed the earlier first-usable-provider rule.

## Maintenance review

Test-only change; no product behavior changes. The customizations inventory, README and onboarding are unchanged.
