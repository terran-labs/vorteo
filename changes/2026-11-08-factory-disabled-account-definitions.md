### Fixes

- Factory picks for another environment reject globally disabled accounts even before that environment refreshes its readiness snapshot.

## Maintenance review

The installation definition's enabled policy now gates cross-environment account mapping. The existing Factory account case covers a disabled definition with a ready destination snapshot. The account-selection inventory is updated; README overview and onboarding are unchanged. Not installed.
