### Tooling

- Seventeen upstream browser tests that check behavior Vorteo changed on purpose are routed out of the browser project by title: the composer diff pill, the context window meter's tooltip, empty state and keyboard trigger, a Command Center check that waits for the removed mode selector, custom model removal at 390 pixels below the Claude sign-in guidance, the inline provider install error, and a Usage Settings disclosure test that asserts CSS. Each entry names the Vorteo commit or testing rule that justifies it and matches its spec file, so a retired title cannot hide a namesake elsewhere.

## Maintenance review

Test routing only; no shipped behavior changes. The composer diff pill stays retired as in 6483ba11c, the meter follows 7723a55f6 and 12eb45f71, the profile picker replaces the mode selector from 471d7f22a, the Claude sign-in guidance follows 8ffd96665, and install errors report through toasts from cdafe96d5. The composer-diff-stat review comment and feedback tests stay routed in because Vorteo ships that review surface; they fail at a stale entry point and need a repair. Vorteo's own question card, hosted connection and mobile workspace tests also need repairs, not upstream routing. README overview and onboarding are unchanged.
