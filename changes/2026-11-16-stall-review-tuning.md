### Fixes

- Stall review leaves a thread alone when its unfinished items are only in progress and an active heartbeat or schedule will wake it.
- A stall review that failed before its prompt was sent no longer counts toward the daily and hourly caps.
- The stall review log line drops its cost field, which always read zero, and the cap skip line now logs the thread's daily count.

## Maintenance review

Two days of monitoring on the Host (57 reviews) found these. The lead thread was reviewed three times although its 9 PM heartbeat already woke it; the service now reads active schedules that target a thread and skips it when only in-progress items remain. Blocked items are still reviewed. On 2026-11-15 one thread was skipped 13 times at the daily cap of 6 with 4 finished reviews in the log; the one path found that kept a slot without sending a prompt was a failed load, which now releases it. That cause is inferred from the code, not confirmed, because the logs from that day were rotated out, so the skip line now logs the per-thread count. The stored session cost does not move during a review, so the cost field is removed instead of reporting zero. The existing review scan test gains the heartbeat case; a mutation without the skip fails it. The agent lifecycle guide is updated; the customizations inventory has no entry that describes these details. README overview and onboarding are unchanged; no merge or installation is included.
