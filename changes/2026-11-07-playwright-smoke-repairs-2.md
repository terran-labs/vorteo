### Fixes

- Restart in a Host's System restart sheet works again. Since the System consolidation it asked the daemon to finish current turns without the approved request that hold needs, so every restart failed. It now restarts directly, as the Host page did. Letting current turns finish remains an installation restart option.
- Closing a compact bottom sheet while it is still opening, for example with Escape, now closes it instead of leaving it stuck open.
- Going back from a compact Settings section to the Settings list no longer leaves a section address such as `/settings/interface` in the address bar.

### Tooling

- The Playwright Metro warm-up also compiles the app's lazily loaded chunks before tests start. The icon chunk alone took about 20 seconds on a cold runner, which made the first test to render plugin icons time out.

## Maintenance review

Repairs the six Playwright smoke failures. Three were product bugs the smoke caught: the System restart sheet's drain request, a compact bottom-sheet close race, and a stale Settings address after compact Back. The fourth was a cold Metro chunk compile. The inventory is unchanged: it already credits finishing current turns to the installation restart workflow, which this change leaves intact. The upstream visibility-tracker test gains the presentation report a real sheet sends before it is hidden. README overview and onboarding are unchanged.
