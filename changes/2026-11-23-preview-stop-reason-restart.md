### Fixes

- A preview that stops because Vorteo restarts is more often shown as stopped by the restart, instead of as a changed process or a stop with no cause. On Nov 23 at 6:35 PM, the broker recorded one preview, stopped while it was being checked, as a changed process, and missed another by 0.19 seconds (#587).

## Maintenance review

Updated the "Private workspace previews and host folders" inventory entry.

- **Stop during a check.** The broker's final re-check during a full verification raises `ServiceGone` when the service is no longer running, so the stop's cause is decided. `ProcessChanged` is kept for a changed fingerprint, terminal or port while running.
- **Seen alive.** A new ledger field, `aliveAt`, records the last time the broker saw the service alive: a full verification, the daemon reporting it running in its recorded terminal at the start of a check, or a passing direct probe. `service_gone_cause` measures its unchanged 30 second window from the later of `verifiedAt` and `aliveAt`, so a cause still needs evidence within one broker cycle.
- **Worker after a survived restart.** After a restart a preview survived, the next successful check records the new daemon worker, so a later exit of the preview reads `exited`. The broker checks the recorded worker in process at the start of each check and reads the serving worker only when the recorded one is gone. It records that worker only if the check succeeds, so a restart during or right after a check still reads `daemon_restart`. The serving worker is read at most once per reconcile run and reused for every entry in it, so a restart does not cost one `lsof` per preview against the run's budget.
- **Not changed.** Widening the window was not done: it would catch more restarts but could name a restart for a service that crashed on its own.
- **Neither earlier broker change caused the Nov 23 results.** #614 and #619 do not change this classification.
- **Delivery.** `aliveAt` is not published in the status file. Needs a broker deployment on Host and Dev. README overview and onboarding are unchanged. Source only; not installed.
