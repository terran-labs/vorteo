### Fixes

- Worker team supervisors keep their assigned preset. The daemon retains each worker's supervisor binding while the worker is running.
- Direct edits to quota thresholds and automatic account eligibility use the same app controls as preset fence settings.
- When Claude rate-limits a usage check, the saved reading keeps the time it was fetched.

## Maintenance review

The worker fence uses the daemon's creator record when tracing supervision. Operators rolling back to a daemon that predates worker teams can follow the empty-team guidance in the protocol compatibility guide.
