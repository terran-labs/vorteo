### Fixes

- The sidebar's Open questions card and All Factories summary no longer redraw on every streamed update from any thread, which made the interface slower while agents were working.

## Maintenance review

The Open questions card and All Factories summary now select only the store data they render, and the Factory stage bar and runner rows are memoized; recorded under "Sidebar cards that stay still while threads stream" in the inventory. No behavior change. README overview and onboarding are unchanged.
