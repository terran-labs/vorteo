### Features

- Review threads that stop with work left in progress, not only blocked work, when nothing else will wake them. Threads with live background work or a running subagent are left alone.

### Fixes

- Never run a stall review on a cold prompt cache. A slot missed by more than 15 minutes is forfeited, so turning the setting on no longer reviews threads that stopped days ago.
- End a thread's review ladder as soon as a review leaves its checklist unchanged.
- Cap reviews at 6 per thread per day and 12 per hour for the installation, and log each review's account, tokens and outcome.

## Maintenance review

Measured on the owner's Host when the setting was turned on: 14 threads blocked for days were reviewed at once, one wrote 612k cache tokens to answer that nothing had changed, and none of the six Claude reviews examined took action. `blockedReviewDue` now forfeits late slots. The review service ends the ladder after an unchanged checklist fingerprint with no new background work, reviews three threads at a time, holds in-memory caps and logs one line per review. In-progress items become reviewable; a thread with only in-progress work is skipped while a subagent runs or its loaded runtime reports live background work through `canStopRuntime`. A review's claim time is no longer moved to its end, so a prompt sent during a long review starts a new stretch. The final-review note is folded into one shorter prompt. No protocol or stored-record field changes. The existing ladder case table covers forfeiture, in-progress eligibility and the fingerprint; existing review tests move inside the warm window. Setting copy is updated in all nine locales; the agent lifecycle and presets guides are updated. README overview and onboarding are unchanged.
