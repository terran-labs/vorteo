### Fixes

- A waiting update that passes its deadline is marked "Your decision needed" in installation controls. Force restart appears for an update only while it is waiting for current work, and older open tabs keep working.

## Maintenance review

Restart hold start times move to coordinator-private state outside the journal, and the deadline flag is reply-only for clients that request it. Rollback steps are in the protocol compatibility guide. README overview and onboarding are unchanged.
