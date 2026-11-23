### Features

- A workspace service, such as a managed preview, whose terminal survives a daemon restart is re-linked to its script before the new daemon listens. It keeps showing as running, Stop works, and its port, proxy route and health check come back. This applies to restarts that already keep terminals: crash restarts, Dev installs, Host installs that wait for idle, and held restarts. Host installs that replace the daemon immediately still close terminals, so their previews still stop until a later change (#587).

### Maintenance

- The daemon keeps an owner-only record of running services, `workspace-script-terminals.json`, read with the bounded regular-file reader and ignored whole when invalid. It re-links or stops a recorded service only when its terminal runs under the same verified worker (pid and birth time) with the workspace, name and directory the launcher gave it. It stops one only when its workspace is archived or gone, and leaves any other surviving terminal running with a log line. Startup waits at most 3 seconds for this. Stop takes a service out of the record before killing it (#587).

## Maintenance review

Updated the "Private workspace previews and host folders" inventory entry with the re-link and its limit, and documented the rule in the terminal worker guide. No protocol change. Needs a daemon restart to take effect, on Host and Dev. A preview broker with restore-after-restart on still refuses a service that survived a restart, so previews behind such a broker keep stopping until the broker change in #587. Rollback needs no preparation: an older daemon ignores the record. README overview and onboarding are unchanged. Source only; not installed.
