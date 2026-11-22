### Fixes

- A thread no longer stops showing new messages after its history was read while the Host had the thread closed. That read hands the app a different version of the history than the live stream, and the app used to drop every new event without asking to catch up, so the thread looked frozen until Reload agent. The app now asks the Host for the current history and resumes live updates. A burst of mismatched events asks once, and if the mismatch persists the app asks again at most every 30 seconds instead of fetching on every event.

## Maintenance review

The client stream reducer now requests a catch-up when a live event arrives in a foreign epoch, bounded per epoch pair to once per 30 seconds; recorded under "Frozen threads recover after a history replacement" in the inventory. One upstream Paseo test expectation changed with the behavior. The daemon-side epoch mismatch and the idle-release loop remain open (#558). Interface only, no wire change. README overview and onboarding are unchanged.
