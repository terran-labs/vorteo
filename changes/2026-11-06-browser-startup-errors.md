### Fixes

- Browser requests now report headless startup failures within 10 seconds, with available exit diagnostics and recent Chromium stderr. Long launch errors fit the existing IPC limit, and failures are logged at warning level.

## Maintenance review

Updated the headless browser inventory for bounded startup failures. Chromium sandbox flags, the Dev image, container settings and wire error shapes are unchanged. The zygote crash remains unresolved. README overview and onboarding are unchanged.
