### Fixes

- Keep usage reset weekdays correct across daylight saving changes by using local calendar day and week cutoffs.

## Maintenance review

Marked a small local correction to Paseo’s exact reset formatter and retained its existing test expectations. Added a day-cutoff regression alongside the existing week case; countdowns, locale and clock formatting are unchanged. README overview and onboarding are unchanged.
