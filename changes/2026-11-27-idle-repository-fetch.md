### Fixes

- The daemon no longer runs `git fetch` every three minutes for every repository a client lists. A repository fetches on that interval only while one of its workspaces is viewed or has a running or starting agent. A stale repository fetches as soon as a workspace becomes active (#675).
- A fetch or other ref change refreshes only active workspaces of the repository. Every 30 minutes each repository fetches and refreshes its idle workspaces, even while a sibling workspace is active, so an idle workspace's sidebar status can lag by up to 30 minutes. The first of these comes within five minutes of the daemon starting, staggered per repository, and at most four run at once (#675).
- The daemon logs when an agent has been initializing for over ten minutes, since that keeps its repository on the frequent fetch (#675).

## Maintenance review

Issue #675. Updated the workspace Git polling entry with the activity-gated background fetch, deferred ref refreshes for idle workspaces and the staggered 30 minute idle release. The fetch timer and the repository refresh fan-out reuse the activity test the degraded poll already had, extended to count an open uncommitted diff. Two cases in the existing workspace Git service suite cover the idle, activation and idle release fetches, and an idle worktree catching up beside an active sibling. README overview and onboarding are unchanged. Source only; installing needs a Host and Dev daemon restart.
