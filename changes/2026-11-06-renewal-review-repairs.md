### Fixes

- Keep renewal diagnostics in an optional sidecar so older coordinators can still read account state. Recording missed expiry no longer delays renewal retries, and recovered storage reads clear transient failures while preserving genuine refresh backoff.

## Maintenance review

Reviewed refresh-state rollback compatibility, retry accounting and authenticated recovery transport. Existing account state retains its original strict schema. Added focused regressions for the review findings; README overview and onboarding remain unchanged.
