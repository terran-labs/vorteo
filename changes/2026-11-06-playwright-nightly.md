### Tooling

- Merges to `main` run a short Playwright smoke of core flows instead of all eight Playwright shards. The full browser suite runs nightly on `main`, on manual runs and on release tags, so merge groups no longer fill GitHub's concurrent job limit and leave other pull requests' required checks waiting.

## Maintenance review

Owner-approved CI routing change: added the `e2e` routing output and the `playwright (smoke)` job, gated the eight shards on `e2e`, and extended the CI workflow test and testing docs. Required checks are unchanged. README overview and onboarding are unchanged.
