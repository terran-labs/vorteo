### Fixes

- Claude full sign-in accounts no longer lose their sign-in when the coordinator's renewal fails. The coordinator stops running the Claude CLI to renew a shared account by default, because a failed renewal erased the account's saved sign-in. Host agents keep renewing it as they work, and Dev receives their tokens.
- An account whose sign-in is gone shows Reconnect on its row in Settings, and the coordinator logs one warning naming it.

### Maintenance

- When coordinator renewal is turned back on with `claudeCoordinatorRefresh`, a failed renewal logs a fixed category from the CLI's result, and the request no longer waits three seconds for input.

## Maintenance review

Coordinator CLI refresh for Claude is now opt-in through `claudeCoordinatorRefresh`; coordinator custody requires it. Added refresh failure categories, a once-per-loss sign-in warning and coordinator-driven Reconnect for named Claude accounts. Documented the Dev trade-off for accounts without an active Host agent in the providers guide. README overview and onboarding are unchanged.
