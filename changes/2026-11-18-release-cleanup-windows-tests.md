### Maintenance

- Skip the Host release cleanup suites on Windows, where the cleanup never runs.

## Maintenance review

The Windows server suite had 41 failing tests in these two files, 6 of them from before release pruning. Grouped by first error: 22 from the cleanup lock's `/bin/ps` call, including one test that times out waiting behind it; 7 from the session host's POSIX-only file checks, 5 of them earlier; 7 from POSIX path handling, where Windows separators and drive letters do not match POSIX fixtures or links; 2 from the process listing refusing Windows; 2 from mode-000 files that Windows still reads; and the earlier Claude probe fixture. None is a fault on macOS or Linux. Both suites join the documented POSIX-only exclusions, which also clears the six earlier failures. On Windows the product refuses before renaming anything: the lock's `ps` call and the process listing both throw. Tests and CI routing only. Not installed.

The refusal is now explicit: `pruneHostReleases`, `restoreSetAsideReleases`, `recordLinkTargets` and the source-update cleanup throw "Host release cleanup is not supported on Windows" on win32 before reading or writing anything, so a run's `retention.json` records that error and no link history is written, and the coordinator's startup restore is a no-op there. A test stubs the platform on macOS and Linux to check each entry point refuses without touching the tree or the history file.
