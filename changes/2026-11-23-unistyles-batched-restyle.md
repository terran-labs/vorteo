### Fixes

- Crossing the compact width, switching theme or light and dark, or changing an interface font no longer freezes the web interface for seconds. Unistyles 3.2.4 rebuilt its whole stylesheet once for every component it restyled, so each of those changes cost the component count times the stylesheet size. The patched library now rebuilds the sheet once after all components restyle, still synchronously, and folds the removals of unused styles into one rebuild per task. In a production export on Settings > Appearance, one breakpoint crossing dropped from 7.0 to 7.6 seconds of main-thread work to 0.9 to 1.4 seconds on the same machine (#609).

### Maintenance

- A unit test counts stylesheet rebuilds per emitted theme change and fails without the batching, including when a subscriber throws.

## Maintenance review

Updated the maintenance review for the Unistyles web patch: the new hunks touch only `web/css/state` and `web/listener`, sit beside the existing registry and native hunks, and should be dropped at Unistyles 3.8.0 or later, which updates individual rules instead of rebuilding the sheet. Styles after a live change match a fresh load and the stock library. This explains the slow fine-pointer resizing noted on 2026-11-09. Native platforms are unchanged. README overview and onboarding are unchanged. Source only; not installed.
