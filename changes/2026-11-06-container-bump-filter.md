### Tooling

- Container builds and smokes skip main pushes whose only change to their files is the per-commit version bump, as CI's path routing already does. Manual runs always build.

## Maintenance review

Owner-approved CI optimization: added a routing job to the Container workflow that reuses the version-bump neutralizer and the existing path filter, and extended the CI workflow test. Required checks are unchanged. README overview and onboarding are unchanged.
