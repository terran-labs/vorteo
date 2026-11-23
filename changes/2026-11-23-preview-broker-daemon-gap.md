### Fixes

- A preview's link on the Host no longer drops for 10 to 30 seconds when the broker happens to check while the daemon restarts. If the preview's server is still the same process and answering, the link stays up for up to a minute while the daemon comes back. The first check afterwards must find the same service and server, so a preview that did not survive the restart is still withdrawn at once (#587).

## Maintenance review

Updated the "Private workspace previews and host folders" inventory entry and the broker README. Builds on the check-timeout change (#358): a CLI failure while the native daemon's pid file is gone or its pinned loopback port refuses becomes `DaemonUnavailable`, which the timeout grace accepts with its own 60 second bound, `DAEMON_GAP_SECONDS`, and fixed messages. A CLI failure while the daemon answers is unchanged. The container broker is unchanged. Needs a broker deployment on the Host. README overview and onboarding are unchanged. Source only; not installed.
