### Fixes

- Dictation state now belongs to one thread for its whole life: switching threads closes the composer's dictation and opens a fresh one, so one thread's unsent recording can never show, send or save in another. A recording left unsent is offered back when its thread opens again, from the device or, when the device could not store it, from memory for as long as the page is open.
- A recording's Host is updated when a draft switches Host before sending, so removing a Host deletes exactly the recordings sent to it, including audio held only in memory.
- A microphone stop that never finishes no longer blocks dictation: after five seconds a new recording starts anyway and a closing composer hands its recording over. Audio held in memory shares the 128 MB storage budget, and the owner is told when the oldest is removed; a recording just handed over is never the one removed.

## Maintenance review

Replaced the per-thread parking of dictation audio with a composer keyed by thread (#570), with tests for the handover on close, thread isolation and the microphone order across composers. Interface only. README overview and onboarding are unchanged.
