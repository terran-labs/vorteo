### Fixes

- Worker placement reuses cached quota readings and skips accounts under an active usage hold, including aliases. Team presets retain their first worker on rollback. An explicitly empty team disables delegation on a daemon that supports teams.

## Maintenance review

Team launch checks refuse when a known team worker's governance cannot be read. Worker launch results include a machine-readable reason code. Recovery checks the saved supervisor binding before reopening a worker.
