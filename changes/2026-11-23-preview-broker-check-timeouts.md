### Fixes

- The Host's preview broker no longer withdraws a healthy preview's link because its own checks time out under load. While the preview's server is the same process, still listening and accepting connections, the link stays up for up to 10 minutes of timed-out checks, and the status says checks are delayed. After that, the link is withdrawn with its own status, `withdrawn`, and returns by itself with the first check that succeeds (#358).

## Maintenance review

Updated the "Private workspace previews and host folders" inventory entry and the broker README. The miss limit (three timeouts) and the 90 second grace are replaced by one 10 minute bound, `PROBE_ONLY_SECONDS`, and the in-process probe gains a direct loopback connect. A curl that exits on its own `--max-time` now counts as a timeout. New ledger and status values: status `withdrawn`, and the fixed message "Checks are delayed; route kept while its listener answers"; older count messages are still accepted from a ledger. The daemon passes broker statuses through unchanged, so it shows both as not responding. The container broker is unchanged: it still withdraws on the first timeout. Needs a broker deployment on the Host. On Dev's broker, the only change is that a timed-out check now reads `withdrawn` instead of `failed`. README overview and onboarding are unchanged. Source only; not installed.
