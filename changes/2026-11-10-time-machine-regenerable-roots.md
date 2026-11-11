### Improvements

- Time Machine skips dependency installs, build output and Host releases without crawling the disk: new task worktrees exclude their `node_modules`, `dist` and `build` folders when dependencies install, the installer excludes the releases folder, and an upkeep command re-applies exclusions to named folders in seconds. Source and project files stay backed up.

## Maintenance review

Added `scripts/lib/time-machine-exclusions.mjs`, its use in the dependency installer and the installer's release step, and `scripts/maintenance/time-machine-exclusions.mjs` for hourly upkeep. It uses Time Machine's sticky per-item exclusion, so it needs no administrator rights; it only adds exclusions and never deletes files. On one Host it marked 325 checkouts in about 10 seconds, replacing a crawl that took up to 22 minutes. The existing dependency cache test suite covers the source-never-marked rule. README overview and onboarding are unchanged.
