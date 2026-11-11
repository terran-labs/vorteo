### Fixes

- When a thread's history fails to load, the error notice and its Retry button now float over the conversation with the other sync notices, so the message field no longer moves.

## Maintenance review

The timeline sync error callout moved from an in-flow row under the conversation into the floating panel notice that already shows Reconnecting and Updating. Retry, its pending state, the test IDs and recovery on reconnect are unchanged. Interface only; this diverges from upstream Paseo's in-flow callout from Paseo #4973. README overview and onboarding are unchanged.
