### Fixes

- When the session host ends, the daemon log now says why each hosted agent was released or continued: a turn in flight, a pending permission, a turn call cut off, reported background work, no cached background work answer, nothing in progress, or a recorded running state at startup.

## Maintenance review

Logging only. The hosted session passes a loss reason with its loss kind, and the daemon adds both to the release line and to a new continuation line, including continuations of agents recorded as running at startup. No behavior or wire change; no test asserts these lines. Not installed. README overview and onboarding are unchanged.
