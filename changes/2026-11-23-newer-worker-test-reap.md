### Maintenance

- The terminal worker test for a worker from a newer Paseo now waits for that worker's process to disappear after a closing stop, instead of checking once. This brings in upstream Paseo's fix (#9290) for a test that failed once in CI (#624).

## Maintenance review

Test only; no shipped behavior changes, so no inventory entry changes. Cherry-picked from upstream Paseo, so the next upstream merge sees the same change. Upstream's comment describes its newer socket-based cleanup. In this tree the reaper decides by `ps`, which shows an exited, unreaped worker as `<defunct>`, so cleanup counts it gone while `kill(pid, 0)` still succeeds until init reaps it. Either way, the wait is for the worker's pid. README overview and onboarding are unchanged. Source only; nothing to install.
