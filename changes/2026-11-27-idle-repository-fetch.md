### Fixes

- The daemon no longer runs `git fetch` every three minutes for every repository a client lists. A repository fetches on that interval only while one of its workspaces is viewed or has a running or starting agent, and every 30 minutes otherwise. A stale repository fetches as soon as a workspace becomes active (#675).
- A fetch or other ref change refreshes only active workspaces of the repository. Idle workspaces refresh when next viewed, read or made active, or after the 30 minute idle fetch, so an idle workspace's sidebar status can lag by up to 30 minutes (#675).

## Maintenance review

Issue #675. Updated the workspace Git polling entry with the activity-gated background fetch and deferred ref refreshes for idle workspaces. The fetch timer and the repository refresh fan-out reuse the activity test the degraded poll already had. One case in the existing workspace Git service suite covers the idle, activation and slow-interval fetches. README overview and onboarding are unchanged. Source only; installing needs a Host and Dev daemon restart.
