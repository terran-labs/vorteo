### Fixes

- Stop agent creation before starting a provider session when shutdown begins during setup. Sessions already starting still complete their required cleanup.

### Maintenance

- Isolate the supervisor stop regression from automatic System agent startup while preserving its shutdown and no-respawn assertions.

## Maintenance review

The agent lifecycle now rechecks shutdown after asynchronous setup and before provider session creation, releasing temporary launch context on rejection. Existing cleanup ownership and deadlines remain unchanged. This does not cancel provider requests already running or establish the cause of the original uninstrumented CI timeout. Nine focused lifecycle cases and the isolated supervisor stop fixture pass. Builds reviewed the rejection cleanup correction; final normal hooks and exact-commit review remain pending. README overview and onboarding are unchanged.
