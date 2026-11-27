### Fixes

- The sidebar's Factory Runners list counts only issues with an agent running or starting. Blocked issues and issues whose threads finished long ago no longer show as active runners; they still appear in the Factory row's stage bar (#683).
- Runners and Crew under a Factory fold like every other sidebar level, with the same arrow and remembered state, and show their count while folded (#683).
- The All Factories summary reads "queued · active · stalled · review", where stalled counts issues past the queue with nothing running (#683).

## Maintenance review

Interface only; no server, protocol or plugin changes. Updated the "Factory sidebar sections" and "All Factories section" inventory entries for the active runner rule, the folding Crew and Runners groups and the stalled count. The existing Factory model test now covers a finished thread, a blocked issue and a running worker giving one active runner. README overview and onboarding are unchanged.
