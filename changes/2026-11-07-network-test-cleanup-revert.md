### Maintenance

- Restore upstream network-test cleanup without retries so an ENOTEMPTY failure remains visible for writer diagnosis. This supersedes `changes/2026-11-06-network-test-cleanup-retry.md`, which is absent from this branch.

## Maintenance review

Removed only the cleanup retry and its rationale from the ignored-proxy warning test. Network gate and proxy behavior are unchanged. README overview and onboarding are unchanged.
