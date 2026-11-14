### Fixes

- The Host watch quotes every worktree path inside Dev, bounds Dev's pass with a time limit there too, counts a worktree whose history cannot be read as unchecked, and handles an empty or contended lock file.

## Maintenance review

Review follow-up on the Host watch: the in-Dev script calls Git through a quoted `g` function so a path can neither split nor add options, the batch runs under `timeout` inside Dev, an unreadable `rev-list` reports `?` and counts as skipped, and stale locks are moved aside and re-read so two runs cannot both take over. README overview and onboarding are unchanged.
