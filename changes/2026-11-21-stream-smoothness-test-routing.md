### Maintenance

- App unit tests now run upstream Paseo's stream-smoothness report test, which no CI job collected because the app Vitest config excluded all of `e2e/`. The exclusions now cover only `e2e/browser/`, where the Playwright specs live, and the unit project names this one file. No other file is collected (#445).

## Maintenance review

Test routing only; no shipped behavior changes, so no inventory entry changes. `packages/app/vitest.config.ts` now differs from upstream on its two `e2e` exclusions and one named include, so a later upstream edit to those lines will need a manual merge; the test file stays byte-identical to upstream. README overview and onboarding are unchanged. Source only; nothing to install.
