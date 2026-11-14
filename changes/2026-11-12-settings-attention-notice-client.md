### Fixes

- Keep the System needs attention button working where no query client is mounted. It read provider and update rows through a hook that required one and failed without it.

## Maintenance review

Follow-up to the settings redesign from its first CI run. The button's extra-row hook now reads the query client from context and skips cache invalidation when there is none. The session host review browser test's fixture ends its session on lock, because the cross-page unlock fix restores owner access on refresh while the server session is valid. The focused browser test and the System settings unit tests pass. The customizations inventory entries and README are unchanged.
