### Fixes

- CI's dependency signature audit no longer fails a pull request when npm's attestations endpoint briefly answers with a non-JSON body. The `lint` job runs the same pinned `npm@11.19.1 audit signatures` through a small script that retries only a registry fetch or parse error, up to three attempts with a 5 and 15 second backoff. Every attempt audits with a fresh, empty npm cache, so it fetches from the registry: npm caches attestation responses for a year and CI restores the npm cache between runs. A package that fails verification still fails the step on the first report, and any other error fails at once (#646).

## Maintenance review

Issue #646, item 1. CI tooling only: `scripts/npm-audit-signatures.mjs` and the lint job's step. The CI workflow test covers a fetch fault that clears, a verification failure and an unknown npm error code that are not retried, and a fault that outlasts three attempts. No inventory entry changes; README overview and onboarding are unchanged.
