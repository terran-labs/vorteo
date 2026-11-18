### Maintenance

- Document when `hostReleaseKeepNewest` may be set and that the startup restore of set-aside Host releases relies on atomic renames rather than a lock.

## Maintenance review

Documentation only, from the third review of safe release pruning. The setting must wait until preview broker deployment pins and every rollback target include the change, and must be removed before rolling back. README overview and onboarding are unchanged. Not installed.
