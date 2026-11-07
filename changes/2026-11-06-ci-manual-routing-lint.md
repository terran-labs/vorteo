### Tooling

- The CI workflow test checks the manual-only desktop and Windows routing with one table, which keeps the test under the lint complexity limit.

## Maintenance review

Lint fix for the Windows manual-routing change: merged the desktop_apps and windows_host routing loops in the CI workflow test into one table, with release tags now asserted for both. No workflow or behavior change; README unchanged.
