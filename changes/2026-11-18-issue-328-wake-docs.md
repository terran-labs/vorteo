### Fixes

- Declare disabled checklist wake readiness in existing strict WebSocket fixtures so capability advertisement preserves handshake, reconnect and browser-tool test coverage.

## Maintenance review

Added explicit false stubs to three existing AgentManager fixtures without changing assertions, test strictness or production behavior. Updated the checklist customization inventory. README overview and onboarding remain unchanged because this repair only updates test fixtures.
