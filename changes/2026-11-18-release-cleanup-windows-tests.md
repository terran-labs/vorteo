### Maintenance

- Skip the Host release cleanup suites on Windows, where the cleanup never runs.

## Maintenance review

The Windows server suite had 41 failing tests in these two files, 6 of them from before release pruning. Grouped by first error: 22 from the cleanup lock's `/bin/ps` call, including one test that times out waiting behind it; 7 from the session host's POSIX-only file checks, 5 of them earlier; 7 from POSIX path handling, where Windows separators and drive letters do not match POSIX fixtures or links; 2 from the process listing refusing Windows; 2 from mode-000 files that Windows still reads; and the earlier Claude probe fixture. None is a fault on macOS or Linux. Both suites join the documented POSIX-only exclusions, which also clears the six earlier failures. On Windows the product refuses before renaming anything: the lock's `ps` call and the process listing both throw. Tests and CI routing only. Not installed.
