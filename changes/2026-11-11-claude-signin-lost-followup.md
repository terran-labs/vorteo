### Maintenance

- The "sign-in is gone" warning fires only when a sign-in that was present disappears, not on an account's first check, and recovery is covered by a test proving it never runs the Claude refresh unless the setting allows it.

## Maintenance review

Review follow-up for coordinator Claude refresh: the sign-in loss warning requires a previously present grant, and tests build the refresher and runtime exactly as an installation without `claudeCoordinatorRefresh` does. No other behavior changes. README overview and onboarding are unchanged.
