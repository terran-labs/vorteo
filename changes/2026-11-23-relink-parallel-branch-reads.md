### Fixes

- When several workspace services survive a daemon restart, the daemon reads their scripts and git branches at the same time instead of one after another, so three or more services in slow checkouts no longer use up the 3 second startup limit and leave every service unlinked (#587).

## Maintenance review

No inventory change: the re-link entry already states the 3 second limit and the 1 second branch read, which are unchanged. One case added to the existing re-link suite; it fails with the sequential reads. README overview and onboarding are unchanged. Needs a daemon restart to take effect. Source only; not installed.
