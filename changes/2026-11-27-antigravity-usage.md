### Fixes

- Report Antigravity account quota windows in profile selection, the sidebar quota card, and plugin usage reports by reading `agy -p /usage --output-format json` (staying unavailable when `agy` is missing, signed out, or has no account quota).

## Maintenance review

Daemon and built-in plugin change; source validated locally and handed to Builds for Host delivery. Added `AntigravityQuotaProvider` to the server quota fetcher manifest and registered a matching usage source in `plugins/antigravity-provider` using `agy -p /usage --output-format json`, normalizing Unix-epoch unstarted reset times to null and labeling multi-group buckets consistently with Claude's scoped windows. Updated the "Usage beside account selection" inventory entry; README overview and onboarding are unchanged.
