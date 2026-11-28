### Fixes

- A pending approval now always reaches the owner after the escalation bound. When the escalation timer fired while the system clock still read a little short of the bound, the approval was skipped and, with no timer left, stayed unescalated until something else changed in its thread, so a waiting thread's approval could miss the owner's Open questions (#646).

## Maintenance review

Daemon fix for the approvals escalation from #659. The escalation timer runs on Node's monotonic clock while the bound is checked against the wall clock; when they disagree at the moment the timer fires, the timer now waits out the difference instead of giving up. This was the common cause of three intermittent `agent-manager.test.ts` failures (the escalation bound, the second approval after answering the first, and its perm-b mark). One case added to that file holds the wall clock 5 ms behind the timers; it failed 5 of 5 runs before the fix and passed 5 of 5 after. No wire or inventory change; README overview and onboarding are unchanged.
