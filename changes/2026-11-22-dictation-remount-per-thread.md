### Fixes

- Dictation state now belongs to one thread for its whole life: switching threads closes the composer's dictation and opens a fresh one, so one thread's unsent recording can never show, send or save in another. A recording left unsent is offered back when its thread opens again, from the device or, when the device could not store it, from memory for as long as the page is open.
- A recording's Host is updated when a draft switches Host before sending, so removing a Host deletes exactly the recordings sent to it.

## Maintenance review

Work in progress for #570: replaced the per-thread parking of dictation audio with a composer keyed by thread. Interface only. README overview and onboarding are unchanged.
