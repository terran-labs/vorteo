### Improvements

- Dashboard records observed hourly usage changes and separates Factory queue stages, merges and linked closures. Phone navigation works across sidebar views, and charts preserve missing observations.
- Each daemon now preserves recoverable observations from damaged dashboard history and cancels outstanding source reads during shutdown.

## Maintenance review

Added cancellation during collection, recovery for damaged history, and eligibility checks for newsletter source counts. Each daemon keeps its own history.
