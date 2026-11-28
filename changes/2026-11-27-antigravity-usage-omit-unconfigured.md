### Fixes

- Omit unconfigured Antigravity from `provider.usage.list` when `agy` is not installed so hosts without Antigravity do not show an unavailable Antigravity card in Host Usage settings.

## Maintenance review

Daemon-only fix following #705; source validated locally and handed to Builds. Added an optional `isApplicable()` check to `ProviderUsageFetcher`, implemented by `AntigravityQuotaProvider` to include Antigravity only when explicitly configured or when `agy` is found on `PATH` without probing. Keeps `usage-sources.e2e.test.ts` unchanged and green when `agy` is absent. Updated the "Usage beside account selection" inventory entry; README overview and onboarding are unchanged.
