### Fixes

- Creating a workspace on another host without a path now returns a readable error instead of a bare validation error.

## Maintenance review

The remote workspace API requires an explicit destination path. Its existing connected-host test now covers the missing-path error, and the Factory reference and host-orchestration inventory describe that requirement. No agent charter or instructions change. README overview and onboarding are unchanged. Not installed.
