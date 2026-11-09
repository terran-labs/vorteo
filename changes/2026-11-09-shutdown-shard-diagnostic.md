### Maintenance

- Prepare one instrumented execution of the original concurrent CLI shard to capture pending shutdown tasks and event-loop timing, retaining logs on failure.

## Maintenance review

Diagnostic branch only. The original shard runner, test assertions and shutdown deadlines remain unchanged. Synthetic CPU load is removed. Builds review and normal hooks are required before dispatch; execution and release acceptance remain pending. README overview and onboarding are unchanged.
