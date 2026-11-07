### Fixes

- Load installation recovery dependencies only when authentication needs recovery, keeping history discovery within its existing memory budget.

## Maintenance review

Reviewed authentication recovery loading after the large-history CI regression. The default recovery invocation now loads its transport lazily; injected recovery, deduplication and error handling remain unchanged. Existing tests and heap limits are unchanged. README overview and onboarding are unaffected.
