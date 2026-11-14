### Fixes

- Ask for Codex reconnection when authentication setup or turn-start RPCs refuse a refresh, even while the old access token still answers usage requests. A refusal from an older sign-in cannot mark a completed reconnect as rejected.

## Maintenance review

Updated the Codex account recovery entry to include start RPC exceptions. Session-level tests use synthetic auth files and a fake app server to cover early setup, turn-start rejection and reconnect races. README overview and onboarding are unchanged. Source correction only; Builds owns installation and independent re-review.
