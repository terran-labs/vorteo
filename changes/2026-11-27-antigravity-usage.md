### Fixes

- Report Antigravity account quota windows in profile selection, the sidebar quota card, and plugin usage reports by reading `agy --log-file /dev/null -p /usage --output-format json` at most once every 5 minutes during background sampling (staying unavailable when `agy` is missing, signed out, or has no account quota).

## Maintenance review

Daemon and built-in plugin change; source validated locally and handed to Builds for Host and Dev delivery. Added `AntigravityQuotaProvider` to the server quota fetcher manifest with a 5-minute `minPollIntervalMs` enforced in `ProviderUsageService`, `findExecutableWithoutProbing`, neutral temp-directory cwd, null log redirection, stdout size bounds, process-group cleanup on exit and timeout, narrowed signed-out and no-quota classification backed by a real signed-out fixture, and sanitized client error messages; registered the matching usage source in `plugins/antigravity-provider`. Updated the "Usage beside account selection" inventory entry; README overview and onboarding are unchanged.
