### Maintenance

- Merged current main into the required-check scheduling change. The Playwright smoke and nightly shards wait for format, lint and typecheck while retaining their existing routing and cancellation guards.

## Maintenance review

Resolved the workflow and test conflicts by keeping main’s smoke-versus-full-suite selection and the scheduling prerequisites for every heavy job. Required check definitions, suite commands, README overview and onboarding are unchanged.
