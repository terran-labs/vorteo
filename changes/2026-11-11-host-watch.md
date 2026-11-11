### Improvements

- A read-only Host check reports file-table pressure (system, the Docker VM process and Dev's cached shared-folder inodes), task worktrees with uncommitted or unpushed work older than a day, and whether the latest completed Time Machine backup contains the precious folders. Hourly upkeep can alert on it.

## Maintenance review

Added `scripts/maintenance/host-watch.mjs` and its unit tests, routed into the existing scripts CI job. It changes nothing on the Host. The docs describe two cache-pressure mitigations for the Docker VM that need the owner's Docker administration approval and are not shipped. Daemon push notifications for these alerts are tracked in #348. README overview and onboarding are unchanged.
