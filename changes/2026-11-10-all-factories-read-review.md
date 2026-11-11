### Fixes

- Read a paused Factory snapshot once even when an inactive panel already created its cache entry. Bound summary queue reads to three shared slots and give them bounded priority while continuing to serve waiting card reads. Retry only failed reads.

## Maintenance review

Addressed independent review findings in Factory sidebar cache activation and queue concurrency. README overview and onboarding are unchanged.
