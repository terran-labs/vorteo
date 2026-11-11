### Fixes

- Claude CLIs for the same account now start one at a time, each waiting until the previous one finishes starting (at most 15 seconds), so two CLIs no longer race the account's sign-in refresh. Other accounts never wait.
- A session host upgrade no longer releases a Claude agent whose CLI is under 60 seconds old, and host shutdown waits up to 10 seconds for such CLIs before stopping them. The daemon's own idle cleanup applies the same check.

### Features

- Optional Claude Code debug logs for diagnosing sign-in loss: `$PASEO_HOME/claude-debug-logs.json` with `{"enabled": true}` passes Claude Code's documented `--debug-file` to every new CLI, one file per start under a private per-account directory in `$PASEO_HOME/logs/claude-debug`. Off by default and read at each start, so no restart is needed to toggle it.

## Maintenance review

The 11-11 sign-in loss investigation found three Claude 2 CLIs started together at the edge of the refresh window and released 42 seconds later for a session host upgrade, after which the access token was revoked and the CLI erased the grant. This change keeps one account's CLI starts apart, keeps young or refreshing CLIs alive through idle release and bounded shutdown, and adds opt-in debug logs to confirm the cause at the next refresh window. Claude Code 2.1.321 refreshes its sign-in during startup and already serializes refreshes between running CLIs with its own `.oauth_refresh.lock`, so the remaining exposure is a CLI killed after the server rotated the token but before the Keychain save; the settle window covers startup only, and a running turn or control call was already never released. Debug logs contain only what Claude Code writes in debug mode; Vorteo adds nothing to them, and whether Claude Code ever writes credential material there is not independently verified. The durable sessions entry is updated. Delivery needs a session-host restart through the tracked lifecycle workflow plus a daemon restart; not installed. README overview and onboarding are unchanged.
