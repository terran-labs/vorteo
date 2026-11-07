### Tooling

- Merge-group, nightly, manual and release CI runs build the server stack once in a new `build` job and share it with the Ubuntu server, app, Playwright and CLI E2E jobs and the macOS file-observation job, which previously each rebuilt it. Jobs fall back to building locally when the shared build is unavailable, and the required checks are unchanged.

## Maintenance review

CI tooling only; no shipped behavior changes. The CLI E2E runner gains a `PASEO_PREBUILT_SERVER_STACK` opt-out that only CI sets. Windows suites, the manual-only desktop suites, `cli-unit`, `quality` and `typecheck` keep their own builds. README overview and onboarding are unchanged. Merging current main pushed the CI workflow test over the lint complexity limit, so the manual-only desktop and Windows routing check moved into a helper.
