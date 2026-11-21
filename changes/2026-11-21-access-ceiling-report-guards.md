### Fixes

- Report-only access ceiling logging can no longer change a tool's result. Every reporting hook now runs inside one guard that catches thrown errors and rejected promises, including the reading of its own arguments. Before this, a schedule target that reporting could not serialise could turn a successful schedule create, update, run or resume into a tool error while the change stood, and a malformed permission answer could leave an unhandled rejection (#530).

## Maintenance review

Fix to the report-only supervisor access ceiling; the inventory entry is unchanged because its behaviour and logged lines are unchanged. Ten test cases, each of which fails when the guard is a pass-through, cover poisoned schedule targets against reporting stubbed out, hostile inputs to each report helper and evaluation methods that reject. README overview and onboarding are unchanged. Source only; not installed.
