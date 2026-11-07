### Tests

- The Playwright smoke follows the current interface: daemon restart checks open the Host restart sheet in System, active-turn steering replays no longer select the removed Default send choice, and narrow-window Settings checks wait for the header menu before opening it.
- Browser test runs fill Playwright's transform cache for the built client and protocol modules before workers start, so two workers on a fresh runner no longer read each other's half-written module and fail with a missing `ChunkedTransport` export.
- Three upstream Settings tests for controls Vorteo removed (the composer model selector and labeled docked navigation at 600 to 720 pixels) are routed out of the browser project by title.

## Maintenance review

Test-only repair for the merge-group smoke job; no shipped behavior changes. Restart controls stay where 90ea0adb4 moved them, the composer keeps queue-first sending from 471d7f22a and eb9b43e80, and narrow windows keep the icon rail from 912be3133. The routed-out upstream tests should be re-checked after each upstream merge. README overview and onboarding are unchanged.
