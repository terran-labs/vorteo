### Fixes

- Coordinator account switches keep unset thinking unset and preserve explicit thinking choices instead of runtime observations. Known effective permission modes and features carry over; unknown modes still refuse when the target advertises selectable modes.
- Cross-family targets and unsupported explicit settings return `incompatible-target` before ordinary mode admission, without replacing the source session. App switching and source-only dry runs keep their existing behavior.

## Maintenance review

Updated the account-switching inventory with configured thinking and effective permission preservation. Fake-provider regressions cover unset selections, runtime differences, structured refusals and ordinary mode changes. README overview and onboarding are unchanged. Daemon installation and disposable-thread live acceptance remain with Builds.
